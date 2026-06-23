package gitview

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"mindfs/server/internal/fs"
)

type StatusItem struct {
	Path      string `json:"path"`
	OldPath   string `json:"old_path,omitempty"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	IsDir     bool   `json:"is_dir,omitempty"`
}

type StatusResult struct {
	Available  bool         `json:"available"`
	Branch     string       `json:"branch,omitempty"`
	DirtyCount int          `json:"dirty_count"`
	Items      []StatusItem `json:"items"`
}

type BranchItem struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
}

type BranchListResult struct {
	Current  string       `json:"current,omitempty"`
	Branches []BranchItem `json:"branches"`
}

type WorktreeItem struct {
	Path    string `json:"path"`
	Branch  string `json:"branch,omitempty"`
	Head    string `json:"head,omitempty"`
	Current bool   `json:"current"`
}

type WorktreeListResult struct {
	Items []WorktreeItem `json:"items"`
}

type DiffResult struct {
	Path      string             `json:"path"`
	OldPath   string             `json:"old_path,omitempty"`
	Status    string             `json:"status"`
	Additions int                `json:"additions"`
	Deletions int                `json:"deletions"`
	Content   string             `json:"content"`
	FileMeta  []fs.FileMetaEntry `json:"file_meta,omitempty"`
}

type HistoryItem struct {
	Hash       string `json:"hash"`
	Message    string `json:"message"`
	CommitTime string `json:"commit_time"`
	Remote     bool   `json:"remote"`
}

type HistoryResult struct {
	Available     bool          `json:"available"`
	Items         []HistoryItem `json:"items"`
	HasMore       bool          `json:"has_more"`
	CommitMissing bool          `json:"commit_missing,omitempty"`
	RemoteHead    string        `json:"remote_head,omitempty"`
}

type CommitFilesResult struct {
	Commit string       `json:"commit"`
	Items  []StatusItem `json:"items"`
}

type repoContext struct {
	repoRoot string
	rootPath string
	prefix   string
	branch   string
}

func InspectStatus(ctx context.Context, rootPath string) (StatusResult, error) {
	repo, err := loadRepoContext(ctx, rootPath)
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return StatusResult{}, err
		}
		if isNotRepoError(err) {
			return StatusResult{Available: false, Items: []StatusItem{}}, nil
		}
		return StatusResult{}, err
	}
	items, err := repo.statusItems(ctx)
	if err != nil {
		return StatusResult{}, err
	}
	return StatusResult{
		Available:  true,
		Branch:     repo.branch,
		DirtyCount: len(items),
		Items:      items,
	}, nil
}

func HasRepo(ctx context.Context, rootPath string) (bool, error) {
	_, err := loadRepoContext(ctx, rootPath)
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return false, err
		}
		if isNotRepoError(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func IsWorktree(rootPath string) (bool, error) {
	gitPath := filepath.Join(filepath.Clean(rootPath), ".git")
	info, err := os.Stat(gitPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return info.Mode().IsRegular(), nil
}

func ListBranches(ctx context.Context, rootPath string) (BranchListResult, error) {
	repo, err := loadRepoContext(ctx, rootPath)
	if err != nil {
		return BranchListResult{}, err
	}
	output, err := runGit(ctx, repo.repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/heads")
	if err != nil {
		return BranchListResult{}, err
	}
	seen := map[string]struct{}{}
	branches := make([]BranchItem, 0)
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		name := strings.TrimSpace(scanner.Text())
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		branches = append(branches, BranchItem{Name: name, Current: name == repo.branch})
	}
	if err := scanner.Err(); err != nil {
		return BranchListResult{}, err
	}
	return BranchListResult{Current: repo.branch, Branches: branches}, nil
}

func CheckoutBranch(ctx context.Context, rootPath, branch string) error {
	repo, err := loadRepoContext(ctx, rootPath)
	if err != nil {
		return err
	}
	branch = strings.TrimSpace(branch)
	if branch == "" {
		return errors.New("branch required")
	}
	if strings.ContainsAny(branch, "\x00\r\n") {
		return errors.New("invalid branch")
	}
	found := false
	branches, err := ListBranches(ctx, rootPath)
	if err != nil {
		return err
	}
	for _, item := range branches.Branches {
		if item.Name == branch {
			found = true
			break
		}
	}
	if !found {
		return errors.New("branch not found")
	}
	_, err = runGit(ctx, repo.repoRoot, "checkout", branch)
	return err
}

func ListWorktrees(ctx context.Context, rootPath string) (WorktreeListResult, error) {
	if _, err := loadRepoContext(ctx, rootPath); err != nil {
		return WorktreeListResult{}, err
	}
	output, err := runGit(ctx, rootPath, "worktree", "list", "--porcelain")
	if err != nil {
		return WorktreeListResult{}, err
	}
	currentRoot, err := filepath.Abs(rootPath)
	if err != nil {
		currentRoot = rootPath
	}
	currentRoot = filepath.Clean(currentRoot)

	var items []WorktreeItem
	var item WorktreeItem
	flush := func() {
		if strings.TrimSpace(item.Path) == "" {
			item = WorktreeItem{}
			return
		}
		cleanPath := filepath.Clean(item.Path)
		item.Path = cleanPath
		item.Current = cleanPath == currentRoot
		items = append(items, item)
		item = WorktreeItem{}
	}
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			flush()
			continue
		}
		key, value, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		switch key {
		case "worktree":
			if strings.TrimSpace(item.Path) != "" {
				flush()
			}
			item.Path = value
		case "HEAD":
			item.Head = value
		case "branch":
			item.Branch = strings.TrimPrefix(value, "refs/heads/")
		}
	}
	if err := scanner.Err(); err != nil {
		return WorktreeListResult{}, err
	}
	flush()
	return WorktreeListResult{Items: items}, nil
}

func AddWorktree(ctx context.Context, rootPath, targetPath, branchMode, branch string) error {
	if _, err := loadRepoContext(ctx, rootPath); err != nil {
		return err
	}
	args := []string{"worktree", "add"}
	if branchMode == "new" {
		if strings.TrimSpace(branch) == "" {
			return errors.New("branch required")
		}
		args = append(args, "-b", branch)
	} else if strings.TrimSpace(branch) == "" {
		return errors.New("branch required")
	}
	args = append(args, targetPath)
	if branchMode != "new" && strings.TrimSpace(branch) != "" {
		args = append(args, branch)
	}
	_, err := runGit(ctx, rootPath, args...)
	return err
}

func RemoveWorktree(ctx context.Context, rootPath string) error {
	isWorktree, err := IsWorktree(rootPath)
	if err != nil {
		return err
	}
	if !isWorktree {
		return errors.New("current root is not a git worktree")
	}
	commonDir, err := runGit(ctx, rootPath, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return err
	}
	commonDir = strings.TrimSpace(commonDir)
	if commonDir == "" {
		return errors.New("empty git common dir")
	}
	cleanRoot := filepath.Clean(rootPath)
	cmd := exec.CommandContext(ctx, "git", "--git-dir", commonDir, "worktree", "remove", cleanRoot)
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("[git] command.error dir=%q args=%q err=%v output=%q", "", cmd.Args[1:], err, strings.TrimSpace(string(output)))
		return fmt.Errorf("git %s failed: %w: %s", strings.Join(cmd.Args[1:], " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

func ReadDiff(ctx context.Context, rootPath, relPath string) (DiffResult, error) {
	repo, err := loadRepoContext(ctx, rootPath)
	if err != nil {
		return DiffResult{}, err
	}
	items, err := repo.statusItems(ctx)
	if err != nil {
		return DiffResult{}, err
	}
	var matched *StatusItem
	for i := range items {
		if items[i].Path == relPath {
			matched = &items[i]
			break
		}
	}
	if matched == nil {
		return DiffResult{}, errors.New("git diff not found for path")
	}
	content, err := repo.diffContent(ctx, *matched)
	if err != nil {
		return DiffResult{}, err
	}
	return DiffResult{
		Path:      matched.Path,
		Status:    matched.Status,
		Additions: matched.Additions,
		Deletions: matched.Deletions,
		Content:   content,
	}, nil
}

func ListHistory(ctx context.Context, rootPath string, limit int, beforeCommit, afterCommit string) (HistoryResult, error) {
	repo, err := loadRepoContext(ctx, rootPath)
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return HistoryResult{}, err
		}
		if isNotRepoError(err) {
			return HistoryResult{Available: false, Items: []HistoryItem{}}, nil
		}
		return HistoryResult{}, err
	}
	if limit <= 0 {
		limit = 10
	}
	if limit > 100 {
		limit = 100
	}
	beforeCommit = strings.TrimSpace(beforeCommit)
	afterCommit = strings.TrimSpace(afterCommit)
	if beforeCommit != "" && !repo.commitExists(ctx, beforeCommit) {
		return HistoryResult{Available: true, Items: []HistoryItem{}, CommitMissing: true, RemoteHead: repo.remoteHistoryHead(ctx)}, nil
	}
	if afterCommit != "" && !repo.commitExists(ctx, afterCommit) {
		return HistoryResult{Available: true, Items: []HistoryItem{}, CommitMissing: true, RemoteHead: repo.remoteHistoryHead(ctx)}, nil
	}
	remoteHead := repo.remoteHistoryHead(ctx)

	args := []string{"log", "--format=%H%x00%s%x00%cI%x00", fmt.Sprintf("--max-count=%d", limit+1)}
	if afterCommit != "" {
		args = append(args, afterCommit+"..HEAD")
	} else if beforeCommit != "" {
		parents, err := repo.commitParents(ctx, beforeCommit)
		if err != nil {
			return HistoryResult{}, err
		}
		if len(parents) == 0 {
			return HistoryResult{Available: true, Items: []HistoryItem{}, HasMore: false, RemoteHead: remoteHead}, nil
		}
		args = append(args, parents...)
	}
	if repo.prefix != "" {
		args = append(args, "--", repo.prefix)
	}
	output, err := runGit(ctx, repo.repoRoot, args...)
	if err != nil {
		return HistoryResult{}, err
	}
	items := parseHistoryItems(output)
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	repo.markRemoteHistoryItems(ctx, items)
	return HistoryResult{Available: true, Items: items, HasMore: hasMore, RemoteHead: remoteHead}, nil
}

func ListCommitFiles(ctx context.Context, rootPath, commit string) (CommitFilesResult, error) {
	repo, err := loadRepoContext(ctx, rootPath)
	if err != nil {
		return CommitFilesResult{}, err
	}
	commit = strings.TrimSpace(commit)
	if commit == "" {
		return CommitFilesResult{}, errors.New("commit required")
	}
	if !repo.commitExists(ctx, commit) {
		return CommitFilesResult{}, errors.New("commit not found")
	}
	statusItems, err := repo.commitNameStatus(ctx, commit)
	if err != nil {
		return CommitFilesResult{}, err
	}
	stats, err := repo.commitNumstat(ctx, commit)
	if err != nil {
		return CommitFilesResult{}, err
	}
	items := make([]StatusItem, 0, len(statusItems))
	for _, item := range statusItems {
		path := repo.fromRepoPath(item.Path)
		if path == "" {
			continue
		}
		oldPath := repo.fromRepoPath(item.OldPath)
		stat := stats[item.Path]
		items = append(items, StatusItem{
			Path:      strings.TrimSuffix(path, "/"),
			OldPath:   oldPath,
			Status:    item.Status,
			Additions: stat[0],
			Deletions: stat[1],
		})
	}
	return CommitFilesResult{Commit: commit, Items: items}, nil
}

func ReadCommitDiff(ctx context.Context, rootPath, commit, relPath string) (DiffResult, error) {
	repo, err := loadRepoContext(ctx, rootPath)
	if err != nil {
		return DiffResult{}, err
	}
	commit = strings.TrimSpace(commit)
	if commit == "" {
		return DiffResult{}, errors.New("commit required")
	}
	if !repo.commitExists(ctx, commit) {
		return DiffResult{}, errors.New("commit not found")
	}
	path := strings.TrimSpace(relPath)
	if path == "" {
		return DiffResult{}, errors.New("path required")
	}
	repoPath := repo.toRepoPath(path)
	files, err := repo.commitNameStatus(ctx, commit)
	if err != nil {
		return DiffResult{}, err
	}
	stats, err := repo.commitNumstat(ctx, commit)
	if err != nil {
		return DiffResult{}, err
	}
	var matched *porcelainItem
	for i := range files {
		if files[i].Path == repoPath {
			matched = &files[i]
			break
		}
	}
	if matched == nil {
		return DiffResult{}, errors.New("git commit diff not found for path")
	}
	contentBytes, err := runGitBytes(ctx, repo.repoRoot, "show", "--format=", "--no-ext-diff", "--find-renames", commit, "--", repoPath)
	if err != nil {
		return DiffResult{}, err
	}
	content := decodeGitDiffOutput(contentBytes, filepath.Ext(matched.Path))
	stat := stats[matched.Path]
	return DiffResult{
		Path:      path,
		OldPath:   repo.fromRepoPath(matched.OldPath),
		Status:    matched.Status,
		Additions: stat[0],
		Deletions: stat[1],
		Content:   content,
	}, nil
}

func loadRepoContext(ctx context.Context, rootPath string) (repoContext, error) {
	rootPath = filepath.Clean(rootPath)
	if resolvedRootPath, err := filepath.EvalSymlinks(rootPath); err == nil {
		rootPath = filepath.Clean(resolvedRootPath)
	}
	repoRootOutput, err := runGit(ctx, rootPath, "rev-parse", "--show-toplevel")
	if err != nil {
		return repoContext{}, err
	}
	repoRoot := strings.TrimSpace(repoRootOutput)
	if repoRoot == "" {
		return repoContext{}, errors.New("empty git repo root")
	}
	if resolvedRepoRoot, err := filepath.EvalSymlinks(repoRoot); err == nil {
		repoRoot = filepath.Clean(resolvedRepoRoot)
	}
	relPrefix, err := filepath.Rel(repoRoot, rootPath)
	if err != nil {
		return repoContext{}, err
	}
	prefix := filepath.ToSlash(relPrefix)
	if prefix == "." {
		prefix = ""
	}
	branchOutput, err := runGit(ctx, repoRoot, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		branchOutput = ""
	}
	return repoContext{
		repoRoot: repoRoot,
		rootPath: rootPath,
		prefix:   prefix,
		branch:   strings.TrimSpace(branchOutput),
	}, nil
}

func (r repoContext) statusItems(ctx context.Context) ([]StatusItem, error) {
	args := []string{"status", "--porcelain=v1", "-z", "--untracked-files=normal"}
	if r.prefix != "" {
		args = append(args, "--", r.prefix)
	}
	output, err := runGit(ctx, r.repoRoot, args...)
	if err != nil {
		return nil, err
	}
	rawItems, err := parsePorcelainV1Z([]byte(output))
	if err != nil {
		return nil, err
	}

	// Batch fetch numstat for all tracked files in one call
	trackedItems := make([]porcelainItem, 0)
	for _, item := range rawItems {
		if item.Status != "??" {
			trackedItems = append(trackedItems, item)
		}
	}
	numstatCache := make(map[string][2]int) // repoPath -> [additions, deletions]
	if len(trackedItems) > 0 {
		numstatCache, err = r.batchNumstat(ctx, trackedItems)
		if err != nil {
			return nil, err
		}
	}

	items := make([]StatusItem, 0, len(rawItems))
	for _, item := range rawItems {
		path := r.fromRepoPath(item.Path)
		if path == "" {
			continue
		}
		path = strings.TrimSuffix(path, "/")
		if shouldIgnoreStatusPath(path) {
			continue
		}
		oldPath := r.fromRepoPath(item.OldPath)

		var additions, deletions int
		isDir := false
		if item.Status == "??" {
			target := filepath.Join(r.rootPath, filepath.FromSlash(path))
			if info, err := os.Stat(target); err == nil && info.IsDir() {
				isDir = true
			} else {
				lines, err := countFileLines(target)
				if err != nil {
					continue
				}
				additions = lines
			}
		} else {
			repoPath := r.toRepoPath(path)
			if stats, ok := numstatCache[repoPath]; ok {
				additions = stats[0]
				deletions = stats[1]
			}
		}

		items = append(items, StatusItem{
			Path:      path,
			OldPath:   oldPath,
			Status:    item.Status,
			Additions: additions,
			Deletions: deletions,
			IsDir:     isDir,
		})
	}
	return items, nil
}

func shouldIgnoreStatusPath(path string) bool {
	for _, part := range strings.Split(filepath.ToSlash(filepath.Clean(path)), "/") {
		if part == ".mindfs" {
			return true
		}
	}
	return false
}

// batchNumstat fetches line stats for all items with one cached and one worktree git call.
func (r repoContext) batchNumstat(ctx context.Context, items []porcelainItem) (map[string][2]int, error) {
	result := make(map[string][2]int)
	if len(items) == 0 {
		return result, nil
	}

	cachedOutput, err := r.batchNumstatHelper(ctx, true, items)
	if err != nil {
		return nil, err
	}
	parseBatchNumstat(cachedOutput, result)

	workOutput, err := r.batchNumstatHelper(ctx, false, items)
	if err != nil {
		return nil, err
	}
	parseBatchNumstat(workOutput, result)

	return result, nil
}

func (r repoContext) batchNumstatHelper(ctx context.Context, cached bool, items []porcelainItem) (string, error) {
	args := []string{"diff", "--numstat"}
	if cached {
		args = append(args, "--cached")
	}
	args = append(args, "--")
	for _, item := range items {
		repoPath := r.toRepoPath(r.fromRepoPath(item.Path))
		args = append(args, repoPath)
	}
	return runGit(ctx, r.repoRoot, args...)
}

func parseBatchNumstat(output string, result map[string][2]int) {
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) < 3 {
			continue
		}
		var add, del int
		if fields[0] != "-" {
			fmt.Sscanf(fields[0], "%d", &add)
		}
		if fields[1] != "-" {
			fmt.Sscanf(fields[1], "%d", &del)
		}
		path := fields[2]
		stats := result[path]
		stats[0] += add
		stats[1] += del
		result[path] = stats
	}
}

func (r repoContext) diffContent(ctx context.Context, item StatusItem) (string, error) {
	repoPath := r.toRepoPath(item.Path)
	if item.Status == "??" {
		target := filepath.Join(r.rootPath, filepath.FromSlash(item.Path))
		return diffAgainstEmptyFile(ctx, r.repoRoot, target)
	}
	parts := make([]string, 0, 2)
	cachedBytes, err := runGitBytes(ctx, r.repoRoot, "diff", "--no-ext-diff", "--cached", "--", repoPath)
	if err != nil {
		return "", err
	}
	cached := decodeGitDiffOutput(cachedBytes, filepath.Ext(item.Path))
	if strings.TrimSpace(cached) != "" {
		parts = append(parts, strings.TrimRight(cached, "\n"))
	}
	workingTreeBytes, err := runGitBytes(ctx, r.repoRoot, "diff", "--no-ext-diff", "--", repoPath)
	if err != nil {
		return "", err
	}
	workingTree := decodeGitDiffOutput(workingTreeBytes, filepath.Ext(item.Path))
	if strings.TrimSpace(workingTree) != "" {
		parts = append(parts, strings.TrimRight(workingTree, "\n"))
	}
	return strings.Join(parts, "\n\n"), nil
}

func (r repoContext) commitExists(ctx context.Context, commit string) bool {
	if strings.TrimSpace(commit) == "" {
		return false
	}
	_, err := runGit(ctx, r.repoRoot, "cat-file", "-e", commit+"^{commit}")
	return err == nil
}

func (r repoContext) commitParents(ctx context.Context, commit string) ([]string, error) {
	output, err := runGit(ctx, r.repoRoot, "rev-list", "--parents", "-n", "1", commit)
	if err != nil {
		return nil, err
	}
	fields := strings.Fields(output)
	if len(fields) <= 1 {
		return []string{}, nil
	}
	return fields[1:], nil
}

func (r repoContext) markRemoteHistoryItems(ctx context.Context, items []HistoryItem) {
	for i := range items {
		output, err := runGit(ctx, r.repoRoot, "branch", "-r", "--contains", items[i].Hash, "--format=%(refname:short)")
		if err != nil {
			continue
		}
		items[i].Remote = strings.TrimSpace(output) != ""
	}
}

func (r repoContext) remoteHistoryHead(ctx context.Context) string {
	upstream, err := runGit(ctx, r.repoRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
	if err != nil {
		return ""
	}
	upstream = strings.TrimSpace(upstream)
	if upstream == "" {
		return ""
	}
	mergeBase, err := runGit(ctx, r.repoRoot, "merge-base", "HEAD", upstream)
	if err != nil {
		return ""
	}
	mergeBase = strings.TrimSpace(mergeBase)
	if mergeBase == "" {
		return ""
	}
	if r.prefix == "" {
		return mergeBase
	}
	output, err := runGit(ctx, r.repoRoot, "log", "--format=%H", "--max-count=1", mergeBase, "--", r.prefix)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(output)
}

func (r repoContext) commitNameStatus(ctx context.Context, commit string) ([]porcelainItem, error) {
	output, err := runGit(ctx, r.repoRoot, "diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", "-M", commit)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(output, "\x00")
	items := make([]porcelainItem, 0)
	for i := 0; i < len(parts); {
		status := strings.TrimSpace(parts[i])
		i++
		if status == "" {
			continue
		}
		code := status
		if len(code) > 1 {
			code = code[:1]
		}
		normalized := "M"
		switch code {
		case "A":
			normalized = "A"
		case "D":
			normalized = "D"
		case "R", "C":
			normalized = "R"
		}
		if normalized == "R" {
			if i+1 >= len(parts) {
				break
			}
			oldPath := strings.TrimSpace(parts[i])
			newPath := strings.TrimSpace(parts[i+1])
			i += 2
			if newPath != "" {
				items = append(items, porcelainItem{Path: newPath, OldPath: oldPath, Status: normalized})
			}
			continue
		}
		if i >= len(parts) {
			break
		}
		path := strings.TrimSpace(parts[i])
		i++
		if path != "" {
			items = append(items, porcelainItem{Path: path, Status: normalized})
		}
	}
	return items, nil
}

func (r repoContext) commitNumstat(ctx context.Context, commit string) (map[string][2]int, error) {
	output, err := runGit(ctx, r.repoRoot, "diff-tree", "--root", "--no-commit-id", "--numstat", "-r", "-M", commit)
	if err != nil {
		return nil, err
	}
	result := make(map[string][2]int)
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) < 3 {
			continue
		}
		var add, del int
		if fields[0] != "-" {
			fmt.Sscanf(fields[0], "%d", &add)
		}
		if fields[1] != "-" {
			fmt.Sscanf(fields[1], "%d", &del)
		}
		path := fields[len(fields)-1]
		result[path] = [2]int{add, del}
	}
	return result, scanner.Err()
}

func (r repoContext) toRepoPath(rootRelativePath string) string {
	if r.prefix == "" {
		return filepath.ToSlash(rootRelativePath)
	}
	if rootRelativePath == "" || rootRelativePath == "." {
		return r.prefix
	}
	return filepath.ToSlash(pathJoinSlash(r.prefix, rootRelativePath))
}

func (r repoContext) fromRepoPath(repoRelativePath string) string {
	value := filepath.ToSlash(strings.TrimSpace(repoRelativePath))
	if value == "" {
		return ""
	}
	if r.prefix == "" {
		return value
	}
	if value == r.prefix {
		return "."
	}
	prefix := r.prefix + "/"
	if !strings.HasPrefix(value, prefix) {
		return ""
	}
	return strings.TrimPrefix(value, prefix)
}

func parseHistoryItems(output string) []HistoryItem {
	parts := strings.Split(output, "\x00")
	items := make([]HistoryItem, 0, len(parts)/3)
	for i := 0; i+2 < len(parts); i += 3 {
		hash := strings.TrimSpace(parts[i])
		if hash == "" {
			continue
		}
		items = append(items, HistoryItem{
			Hash:       hash,
			Message:    strings.TrimSpace(parts[i+1]),
			CommitTime: strings.TrimSpace(parts[i+2]),
		})
	}
	return items
}

type porcelainItem struct {
	Path    string
	OldPath string
	Status  string
}

func parsePorcelainV1Z(data []byte) ([]porcelainItem, error) {
	items := make([]porcelainItem, 0)
	index := 0
	for index < len(data) {
		if index+3 > len(data) {
			return nil, errors.New("invalid git status payload")
		}
		x := data[index]
		y := data[index+1]
		index += 3
		next := bytes.IndexByte(data[index:], 0)
		if next < 0 {
			return nil, errors.New("invalid git status path")
		}
		path := string(data[index : index+next])
		index += next + 1
		item := porcelainItem{Path: path, Status: normalizeStatus(x, y)}
		if x == 'R' || y == 'R' || x == 'C' || y == 'C' {
			oldNext := bytes.IndexByte(data[index:], 0)
			if oldNext < 0 {
				return nil, errors.New("invalid git status rename path")
			}
			item.OldPath = string(data[index : index+oldNext])
			index += oldNext + 1
		}
		items = append(items, item)
	}
	return items, nil
}

func normalizeStatus(x, y byte) string {
	switch {
	case x == '?' && y == '?':
		return "??"
	case x == 'R' || y == 'R' || x == 'C' || y == 'C':
		return "R"
	case x == 'D' || y == 'D':
		return "D"
	case x == 'A' || y == 'A':
		return "A"
	default:
		return "M"
	}
}

func diffAgainstEmptyFile(ctx context.Context, repoRoot, targetPath string) (string, error) {
	tmpFile, err := os.CreateTemp("", "mindfs-git-empty-*")
	if err != nil {
		return "", err
	}
	tmpName := tmpFile.Name()
	tmpFile.Close()
	defer os.Remove(tmpName)
	cmd := exec.CommandContext(ctx, "git", "-C", repoRoot, "diff", "--no-index", "--no-ext-diff", "--", tmpName, targetPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// git diff --no-index returns exit code 1 when differences exist.
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return decodeGitDiffOutput(out, filepath.Ext(targetPath)), nil
		}
		return "", formatGitError(err, out)
	}
	return decodeGitDiffOutput(out, filepath.Ext(targetPath)), nil
}

func countFileLines(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	if len(data) == 0 {
		return 0, nil
	}
	count := bytes.Count(data, []byte{'\n'})
	if data[len(data)-1] != '\n' {
		count += 1
	}
	return count, nil
}

func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := runGitBytes(ctx, dir, args...)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func runGitBytes(ctx context.Context, dir string, args ...string) ([]byte, error) {
	// Add timeout if not already set (30 seconds for Windows compatibility)
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("[git] command.error dir=%q args=%q err=%v output=%q", dir, append([]string{"-C", dir}, args...), err, strings.TrimSpace(string(out)))
		return nil, formatGitError(err, out)
	}
	return out, nil
}

func decodeGitDiffOutput(out []byte, ext string) string {
	if utf8.Valid(out) {
		return string(out)
	}
	if decoded, _, ok := fs.TryDecodeText(out, ext); ok {
		return decoded
	}
	return string(out)
}

func formatGitError(err error, output []byte) error {
	text := strings.TrimSpace(string(output))
	if text == "" {
		return err
	}
	return fmt.Errorf("%w: %s", err, text)
}

func isNotRepoError(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "not a git repository")
}

func pathJoinSlash(parts ...string) string {
	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		if strings.TrimSpace(part) == "" {
			continue
		}
		filtered = append(filtered, strings.Trim(part, "/"))
	}
	return strings.Join(filtered, "/")
}
