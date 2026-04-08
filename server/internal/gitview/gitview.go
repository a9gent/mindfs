package gitview

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

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

type DiffResult struct {
	Path      string             `json:"path"`
	Status    string             `json:"status"`
	Additions int                `json:"additions"`
	Deletions int                `json:"deletions"`
	Content   string             `json:"content"`
	FileMeta  []fs.FileMetaEntry `json:"file_meta,omitempty"`
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
	cached, err := runGit(ctx, r.repoRoot, "diff", "--no-ext-diff", "--cached", "--", repoPath)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(cached) != "" {
		parts = append(parts, strings.TrimRight(cached, "\n"))
	}
	workingTree, err := runGit(ctx, r.repoRoot, "diff", "--no-ext-diff", "--", repoPath)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(workingTree) != "" {
		parts = append(parts, strings.TrimRight(workingTree, "\n"))
	}
	return strings.Join(parts, "\n\n"), nil
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
			return string(out), nil
		}
		return "", formatGitError(err, out)
	}
	return string(out), nil
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
	// Add timeout if not already set (30 seconds for Windows compatibility)
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", formatGitError(err, out)
	}
	return string(out), nil
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
