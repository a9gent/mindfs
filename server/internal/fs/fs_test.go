package fs

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

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

func TestSharedFileWatcherSkipsRecursiveWatchForHighFanoutDirectory(t *testing.T) {
	rootDir := t.TempDir()
	wideDir := filepath.Join(rootDir, "wide")
	if err := os.Mkdir(wideDir, 0o755); err != nil {
		t.Fatalf("Mkdir returned error: %v", err)
	}
	for i := 0; i <= maxDirectChildDirsRecursiveWatch; i++ {
		if err := os.Mkdir(filepath.Join(wideDir, fmt.Sprintf("dir-%03d", i)), 0o755); err != nil {
			t.Fatalf("Mkdir child %d returned error: %v", i, err)
		}
	}

	root := NewRootInfo("mindfs", "mindfs", rootDir)
	watcher := &SharedFileWatcher{root: root}
	if !watcher.shouldSkipRecursiveWatch(wideDir) {
		t.Fatalf("shouldSkipRecursiveWatch(%q) = false, want true", wideDir)
	}
}

func TestSharedFileWatcherDoesNotCountIgnoredChildrenForFanoutLimit(t *testing.T) {
	rootDir := t.TempDir()
	dir := filepath.Join(rootDir, "deps")
	if err := os.MkdirAll(filepath.Join(dir, "node_modules"), 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	for i := 0; i < maxDirectChildDirsRecursiveWatch; i++ {
		if err := os.Mkdir(filepath.Join(dir, fmt.Sprintf("dir-%03d", i)), 0o755); err != nil {
			t.Fatalf("Mkdir child %d returned error: %v", i, err)
		}
	}

	root := NewRootInfo("mindfs", "mindfs", rootDir)
	watcher := &SharedFileWatcher{root: root}
	if watcher.shouldSkipRecursiveWatch(dir) {
		t.Fatalf("shouldSkipRecursiveWatch(%q) = true, want false", dir)
	}
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
