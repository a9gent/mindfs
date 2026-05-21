package fs

import (
	"errors"
	"os"
	"path/filepath"
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
