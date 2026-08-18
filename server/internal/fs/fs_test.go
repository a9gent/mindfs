package fs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func TestRegistryUpsertRejectsSameNameDifferentPath(t *testing.T) {
	registry := NewRegistry(filepath.Join(t.TempDir(), "registry.json"))
	first := filepath.Join(t.TempDir(), "project")
	second := filepath.Join(t.TempDir(), "project")
	if err := os.Mkdir(first, 0o755); err != nil {
		t.Fatalf("Mkdir first returned error: %v", err)
	}
	if err := os.Mkdir(second, 0o755); err != nil {
		t.Fatalf("Mkdir second returned error: %v", err)
	}

	created, err := registry.Upsert(first)
	if err != nil {
		t.Fatalf("first Upsert returned error: %v", err)
	}
	again, err := registry.Upsert(first)
	if err != nil {
		t.Fatalf("same-path Upsert returned error: %v", err)
	}
	if again.RootPath != created.RootPath {
		t.Fatalf("same-path Upsert RootPath = %q, want %q", again.RootPath, created.RootPath)
	}

	_, err = registry.Upsert(second)
	if !errors.Is(err, ErrRootNameConflict) {
		t.Fatalf("different-path Upsert error = %v, want ErrRootNameConflict", err)
	}
}

func TestMetaLocationForNewRootPrefersExistingProjectMetadata(t *testing.T) {
	rootDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(rootDir, ".mindfs"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := MetaLocationForNewRoot(rootDir, MetaLocationHome)
	if err != nil {
		t.Fatal(err)
	}
	if got != MetaLocationProject {
		t.Fatalf("location = %q, want project", got)
	}
}

func TestHomeMetadataReusesSameAbsolutePathAndRejectsDifferentPath(t *testing.T) {
	originalHome := userHomeDir
	home := t.TempDir()
	userHomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() { userHomeDir = originalHome })

	parentA := t.TempDir()
	rootPath := filepath.Join(parentA, "project")
	if err := os.Mkdir(rootPath, 0o755); err != nil {
		t.Fatal(err)
	}
	root := NewRootInfo("project", "project", rootPath)
	root.MetaLocation = MetaLocationHome
	if _, err := root.EnsureMetaDir(); err != nil {
		t.Fatal(err)
	}
	if err := root.WriteMetaFile("state.json", []byte(`{"cursor":"ok"}`)); err != nil {
		t.Fatal(err)
	}

	readded := NewRootInfo("project", "project", rootPath)
	readded.MetaLocation = MetaLocationHome
	if _, err := readded.EnsureMetaDir(); err != nil {
		t.Fatalf("same-path reuse failed: %v", err)
	}
	read, err := readded.ReadFile(".mindfs/state.json", 0, 0, "full")
	if err != nil {
		t.Fatal(err)
	}
	if read.Path != ".mindfs/state.json" || !strings.Contains(read.Content, `"ok"`) {
		t.Fatalf("virtual metadata read = %#v", read)
	}
	location, err := MetaLocationForNewRoot(rootPath, MetaLocationProject)
	if err != nil {
		t.Fatal(err)
	}
	if location != MetaLocationHome {
		t.Fatalf("same-path re-add location = %q, want home", location)
	}

	parentB := t.TempDir()
	otherPath := filepath.Join(parentB, "project")
	if err := os.Mkdir(otherPath, 0o755); err != nil {
		t.Fatal(err)
	}
	other := NewRootInfo("project", "project", otherPath)
	other.MetaLocation = MetaLocationHome
	if _, err := other.EnsureMetaDir(); err == nil {
		t.Fatal("different project path unexpectedly reused home metadata")
	}
}

func TestEmptyMetaLocationDefaultsToProject(t *testing.T) {
	rootDir := t.TempDir()
	root := NewRootInfo("project", "project", rootDir)
	if root.EffectiveMetaLocation() != MetaLocationProject {
		t.Fatalf("effective location = %q", root.EffectiveMetaLocation())
	}
	if root.MetaDir() != filepath.Join(rootDir, ".mindfs") {
		t.Fatalf("MetaDir = %q", root.MetaDir())
	}
}

func TestRegistryRenameMovesHomeMetadataAndUpdatesIdentity(t *testing.T) {
	originalHome := userHomeDir
	home := t.TempDir()
	userHomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() { userHomeDir = originalHome })

	parent := t.TempDir()
	oldPath := filepath.Join(parent, "old-project")
	newPath := filepath.Join(parent, "new-project")
	if err := os.Mkdir(oldPath, 0o755); err != nil {
		t.Fatal(err)
	}
	root := NewRootInfo("old-project", "old-project", oldPath)
	root.MetaLocation = MetaLocationHome
	if _, err := root.EnsureMetaDir(); err != nil {
		t.Fatal(err)
	}
	if err := root.WriteMetaFile("state.json", []byte(`{"cursor":"kept"}`)); err != nil {
		t.Fatal(err)
	}

	registry := NewRegistry(filepath.Join(t.TempDir(), "registry.json"))
	if _, err := registry.UpsertWithMetaLocation(oldPath, MetaLocationHome); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(oldPath, newPath); err != nil {
		t.Fatal(err)
	}
	renamed, err := registry.Rename("old-project", "new-project", newPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".mindfs", "old-project")); !os.IsNotExist(err) {
		t.Fatalf("old metadata directory still exists: %v", err)
	}
	if _, err := renamed.EnsureMetaDir(); err != nil {
		t.Fatalf("renamed identity invalid: %v", err)
	}
	state, err := renamed.ReadMetaFile("state.json")
	if err != nil || !strings.Contains(string(state), "kept") {
		t.Fatalf("renamed metadata not preserved: %q, %v", state, err)
	}
}

func TestSharedFileWatcherResolveRelatedFileRecordPlainRoot(t *testing.T) {
	rootDir := t.TempDir()
	root := NewRootInfo("root", "plain-root", rootDir)
	watcher := &SharedFileWatcher{root: root}

	record, ok := watcher.resolveRelatedFileRecord(context.Background(), filepath.Join(rootDir, "notes", "todo.txt"))
	if !ok {
		t.Fatal("resolveRelatedFileRecord returned false")
	}
	if record.repoKind != "plain" {
		t.Fatalf("repoKind = %q, want plain", record.repoKind)
	}
	if record.repoPath != filepath.Clean(rootDir) {
		t.Fatalf("repoPath = %q, want %q", record.repoPath, filepath.Clean(rootDir))
	}
	if record.repoName != "plain-root" {
		t.Fatalf("repoName = %q, want plain-root", record.repoName)
	}
	if record.path != "notes/todo.txt" {
		t.Fatalf("path = %q, want notes/todo.txt", record.path)
	}
}

func TestSharedFileWatcherResolveRelatedFileRecordSiblingGitWorktree(t *testing.T) {
	rootDir := t.TempDir()
	worktreeDir := t.TempDir()
	root := NewRootInfo("root", "main-root", rootDir)
	watcher := &SharedFileWatcher{
		root: root,
		worktreeResolver: func(ctx context.Context, root RootInfo, filePath string) (RelatedWorktreeMatch, bool) {
			return RelatedWorktreeMatch{
				Path: worktreeDir,
				Head: "abc123",
			}, true
		},
	}

	record, ok := watcher.resolveRelatedFileRecord(context.Background(), filepath.Join(worktreeDir, "src", "main.go"))
	if !ok {
		t.Fatal("resolveRelatedFileRecord returned false")
	}
	if record.repoKind != "git" {
		t.Fatalf("repoKind = %q, want git", record.repoKind)
	}
	if record.repoPath != filepath.Clean(worktreeDir) {
		t.Fatalf("repoPath = %q, want %q", record.repoPath, filepath.Clean(worktreeDir))
	}
	if record.repoName != filepath.Base(filepath.Clean(worktreeDir)) {
		t.Fatalf("repoName = %q, want %q", record.repoName, filepath.Base(filepath.Clean(worktreeDir)))
	}
	if record.path != "src/main.go" {
		t.Fatalf("path = %q, want src/main.go", record.path)
	}
	if record.head != "abc123" {
		t.Fatalf("head = %q, want abc123", record.head)
	}
}

func TestSharedFileWatcherResolveRelatedFileRecordTaskWorktreeAbsolutePath(t *testing.T) {
	rootDir := t.TempDir()
	worktreeDir := filepath.Join(rootDir, ".worktree", "task-55")
	root := NewRootInfo("root", "main-root", rootDir)
	watcher := &SharedFileWatcher{
		root: root,
		worktreeResolver: func(ctx context.Context, root RootInfo, filePath string) (RelatedWorktreeMatch, bool) {
			return RelatedWorktreeMatch{
				Path: worktreeDir,
				Head: "task-head",
			}, true
		},
	}

	record, ok := watcher.resolveRelatedFileRecord(context.Background(), filepath.Join(worktreeDir, "test.json"))
	if !ok {
		t.Fatal("resolveRelatedFileRecord returned false")
	}
	if record.repoPath != filepath.Clean(worktreeDir) {
		t.Fatalf("repoPath = %q, want %q", record.repoPath, filepath.Clean(worktreeDir))
	}
	if record.path != "test.json" {
		t.Fatalf("path = %q, want test.json", record.path)
	}
	if record.head != "task-head" {
		t.Fatalf("head = %q, want task-head", record.head)
	}
}

func TestRootInfoNormalizePathAcceptsAbsolutePathWithoutLeadingSlash(t *testing.T) {
	root := NewRootInfo("mindfs", "mindfs", "/Users/bixin/project/mindfs")

	got, err := root.NormalizePath("Users/bixin/project/mindfs/test.json")
	if err != nil {
		t.Fatalf("NormalizePath returned error: %v", err)
	}
	if got != "test.json" {
		t.Fatalf("NormalizePath = %q, want %q", got, "test.json")
	}
}

func TestRootInfoNormalizePathStripsFragment(t *testing.T) {
	root := NewRootInfo("mindfs", "mindfs", "/Users/bixin/project/mindfs")

	got, err := root.NormalizePath("Users/bixin/project/mindfs/design/test.md#L89")
	if err != nil {
		t.Fatalf("NormalizePath returned error: %v", err)
	}
	if got != "design/test.md" {
		t.Fatalf("NormalizePath = %q, want %q", got, "design/test.md")
	}
}

func TestRootInfoListEntriesIncludesSizeAndMTime(t *testing.T) {
	rootDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(rootDir, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	if err := os.Mkdir(filepath.Join(rootDir, "docs"), 0o755); err != nil {
		t.Fatalf("Mkdir returned error: %v", err)
	}

	root := NewRootInfo("mindfs", "mindfs", rootDir)
	entries, err := root.ListEntries(".")
	if err != nil {
		t.Fatalf("ListEntries returned error: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("ListEntries len = %d, want 2", len(entries))
	}
	if !entries[0].IsDir || entries[0].Name != "docs" {
		t.Fatalf("first entry = %#v, want docs directory", entries[0])
	}
	if entries[0].MTime == "" {
		t.Fatalf("directory mtime is empty")
	}
	if entries[1].IsDir || entries[1].Name != "a.txt" {
		t.Fatalf("second entry = %#v, want a.txt file", entries[1])
	}
	if entries[1].Size != 5 {
		t.Fatalf("file size = %d, want 5", entries[1].Size)
	}
	if entries[1].MTime == "" {
		t.Fatalf("file mtime is empty")
	}
}

func TestRootInfoListEntriesTreatsDirectorySymlinkAsDirectory(t *testing.T) {
	rootDir := t.TempDir()
	targetDir := filepath.Join(rootDir, "target")
	if err := os.Mkdir(targetDir, 0o755); err != nil {
		t.Fatalf("Mkdir returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(targetDir, "child.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	if err := os.Symlink("target", filepath.Join(rootDir, "linked")); err != nil {
		t.Skipf("Symlink unavailable: %v", err)
	}

	root := NewRootInfo("mindfs", "mindfs", rootDir)
	entries, err := root.ListEntries(".")
	if err != nil {
		t.Fatalf("ListEntries returned error: %v", err)
	}
	var linked Entry
	for _, entry := range entries {
		if entry.Name == "linked" {
			linked = entry
			break
		}
	}
	if linked.Name == "" {
		t.Fatalf("linked entry not found: %#v", entries)
	}
	if !linked.IsDir {
		t.Fatalf("linked entry IsDir = false, want true")
	}
	if !linked.IsSymlink {
		t.Fatalf("linked entry IsSymlink = false, want true")
	}

	children, err := root.ListEntries("linked")
	if err != nil {
		t.Fatalf("ListEntries linked returned error: %v", err)
	}
	if len(children) != 1 || children[0].Name != "child.txt" {
		t.Fatalf("linked children = %#v, want child.txt", children)
	}
}

func TestSharedFileWatcherShouldIgnoreLargeGeneratedDirectories(t *testing.T) {
	rootDir := t.TempDir()
	root := NewRootInfo("mindfs", "mindfs", rootDir)
	watcher := &SharedFileWatcher{root: root}

	tests := []struct {
		path string
		want bool
	}{
		{filepath.Join(rootDir, "node_modules"), true},
		{filepath.Join(rootDir, "web", "dist"), true},
		{filepath.Join(rootDir, ".next", "cache"), true},
		{filepath.Join(rootDir, ".mindfs"), true},
		{filepath.Join(rootDir, ".mindfs", "state.json"), true},
		{filepath.Join(rootDir, ".mindfs2"), false},
		{filepath.Join(rootDir, "src"), false},
		{filepath.Join(rootDir, "tmpfile"), false},
	}

	for _, tc := range tests {
		if got := watcher.shouldIgnore(tc.path); got != tc.want {
			t.Fatalf("shouldIgnore(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}

func TestSharedFileWatcherWatchesOnlyRequestedDirectory(t *testing.T) {
	rootDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(rootDir, "a", "b", "c"), 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}

	root := NewRootInfo("mindfs", "mindfs", rootDir)
	watcher, err := NewSharedFileWatcher(root, nil)
	if err != nil {
		t.Fatalf("NewSharedFileWatcher returned error: %v", err)
	}
	defer watcher.Close()

	assertWatched := func(path string, want bool) {
		t.Helper()
		watcher.mu.RLock()
		_, got := watcher.watchedDirs[filepath.Clean(path)]
		watcher.mu.RUnlock()
		if got != want {
			t.Fatalf("watchedDirs[%q] = %v, want %v", path, got, want)
		}
	}

	assertWatched(rootDir, true)
	assertWatched(filepath.Join(rootDir, "a"), false)
	assertWatched(filepath.Join(rootDir, "a", "b"), false)
	assertWatched(filepath.Join(rootDir, "a", "b", "c"), false)

	if err := watcher.WatchDir("a"); err != nil {
		t.Fatalf("WatchDir returned error: %v", err)
	}
	assertWatched(filepath.Join(rootDir, "a"), true)
	assertWatched(filepath.Join(rootDir, "a", "b"), false)
	assertWatched(filepath.Join(rootDir, "a", "b", "c"), false)
}

func TestSharedFileWatcherConcurrentWatchDirAndEvents(t *testing.T) {
	rootDir := t.TempDir()
	root := NewRootInfo("mindfs", "mindfs", rootDir)
	watcher, err := NewSharedFileWatcher(root, nil)
	if err != nil {
		t.Fatalf("NewSharedFileWatcher returned error: %v", err)
	}
	defer watcher.Close()

	const dirCount = 16
	var wg sync.WaitGroup
	for i := 0; i < dirCount; i++ {
		dirName := filepath.Join("dir", string(rune('a'+i)))
		dirPath := filepath.Join(rootDir, dirName)
		if err := os.MkdirAll(dirPath, 0o755); err != nil {
			t.Fatalf("MkdirAll returned error: %v", err)
		}

		wg.Add(2)
		go func() {
			defer wg.Done()
			if err := watcher.WatchDir(dirName); err != nil {
				t.Errorf("WatchDir returned error: %v", err)
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < 8; j++ {
				path := filepath.Join(dirPath, "file.txt")
				if err := os.WriteFile(path, []byte("changed"), 0o644); err != nil {
					t.Errorf("WriteFile returned error: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()
}

func TestRootInfoReadFileDecodesGB18030CodeFile(t *testing.T) {
	rootDir := t.TempDir()
	source := "package main\n\n// 中文注释\nfunc main() {}\n"
	encoded, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte(source))
	if err != nil {
		t.Fatalf("GB18030 encode returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "main.go"), encoded, 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	root := NewRootInfo("mindfs", "mindfs", rootDir)
	got, err := root.ReadFile("main.go", 0, 0, "full")
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	if got.Encoding != "gb18030" {
		t.Fatalf("ReadFile encoding = %q, want gb18030", got.Encoding)
	}
	if got.Content != source {
		t.Fatalf("ReadFile content = %q, want %q", got.Content, source)
	}
}

func TestRootInfoReadFileFullRejectsFilesLargerThanLimit(t *testing.T) {
	rootDir := t.TempDir()
	path := filepath.Join(rootDir, "large.txt")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if err := file.Truncate(maxFullReadBytes + 1); err != nil {
		file.Close()
		t.Fatalf("Truncate returned error: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}

	root := NewRootInfo("mindfs", "mindfs", rootDir)
	_, err = root.ReadFile("large.txt", 0, 0, "full")
	if err == nil {
		t.Fatal("expected full read of large file to fail")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Fatalf("ReadFile error = %v, want too large", err)
	}
}
