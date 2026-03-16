package fs

import (
	"os"
	"path/filepath"
	"testing"
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
