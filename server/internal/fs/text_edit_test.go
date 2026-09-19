package fs

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestTextEditingRoundTripAndConflict(t *testing.T) {
	root := NewRootInfo("test", "test", t.TempDir())
	path := filepath.Join(root.RootPath, "notes.txt")
	original := "\ufeff中文\r\nsecond\r\n"
	if err := os.WriteFile(path, []byte(original), 0750); err != nil {
		t.Fatal(err)
	}
	file, err := root.ReadEditableFile("notes.txt")
	if err != nil || file.Content != original || file.Revision == "" || file.Truncated {
		t.Fatalf("read: %+v %v", file, err)
	}
	updated := "\ufeff修改\r\nsecond\r\n"
	saved, err := root.WriteEditableFile("notes.txt", updated, file.Revision)
	if err != nil || saved.Content != updated || saved.Revision == file.Revision {
		t.Fatalf("save: %+v %v", saved, err)
	}
	data, _ := os.ReadFile(path)
	info, _ := os.Stat(path)
	if string(data) != updated || info.Mode().Perm() != 0750 {
		t.Fatalf("content or permissions changed: %q %v", data, info.Mode())
	}
	if _, err := root.WriteEditableFile("notes.txt", "stale", file.Revision); !errors.Is(err, ErrFileConflict) {
		t.Fatalf("stale save: %v", err)
	}
	// mtime alone is insufficient: detect external changes even with restored timestamps.
	if err := os.WriteFile(path, []byte("external"), 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if _, err := root.WriteEditableFile("notes.txt", "overwrite", saved.Revision); !errors.Is(err, ErrFileConflict) {
		t.Fatalf("external conflict: %v", err)
	}
	latest, _ := root.ReadEditableFile("notes.txt")
	empty, err := root.WriteEditableFile("notes.txt", "", latest.Revision)
	if err != nil || empty.Size != 0 {
		t.Fatalf("empty: %+v %v", empty, err)
	}
	entries, _ := os.ReadDir(root.RootPath)
	if len(entries) != 1 {
		t.Fatalf("leftover temporary files: %v", entries)
	}
}

func TestTextEditingRejectsUnsafeTargets(t *testing.T) {
	root := NewRootInfo("test", "test", t.TempDir())
	external := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(external, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(root.RootPath, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(external), filepath.Join(root.RootPath, "linked-dir")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{external, "../outside.txt", "link.txt", "linked-dir/outside.txt", ".", "missing.txt"} {
		if _, err := root.ReadEditableFile(path); err == nil {
			t.Errorf("read accepted %q", path)
		}
		if _, err := root.WriteEditableFile(path, "overwrite", textRevision([]byte("external"))); err == nil {
			t.Errorf("write accepted %q", path)
		}
	}
	data, _ := os.ReadFile(external)
	if string(data) != "external" {
		t.Fatal("external file changed")
	}
	for _, tc := range []struct {
		name    string
		content []byte
		want    error
	}{
		{"binary", []byte{0, 1, 2}, ErrFileNotEditable},
		{"gb18030", []byte{0xd6, 0xd0}, ErrFileNotEditable},
		{"utf16", []byte{0xff, 0xfe, 0x61, 0}, ErrFileNotEditable},
		{"large", []byte(strings.Repeat("a", MaxEditableFileBytes+1)), ErrFileTooLarge},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(filepath.Join(root.RootPath, tc.name), tc.content, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := root.ReadEditableFile(tc.name); !errors.Is(err, tc.want) {
				t.Fatalf("read: %v", err)
			}
			if _, err := root.WriteEditableFile(tc.name, "text", textRevision(tc.content)); !errors.Is(err, tc.want) {
				t.Fatalf("write: %v", err)
			}
		})
	}
	if err := os.WriteFile(filepath.Join(root.RootPath, "readonly"), []byte("text"), 0400); err != nil {
		t.Fatal(err)
	}
	if _, err := root.WriteEditableFile("readonly", "new", textRevision([]byte("text"))); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("readonly: %v", err)
	}
}

func TestConcurrentTextSavesUseOneRevision(t *testing.T) {
	root := NewRootInfo("test", "test", t.TempDir())
	if err := os.WriteFile(filepath.Join(root.RootPath, "a"), []byte("base"), 0600); err != nil {
		t.Fatal(err)
	}
	file, _ := root.ReadEditableFile("a")
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, content := range []string{"one", "two"} {
		wg.Add(1)
		go func(content string) {
			defer wg.Done()
			_, err := root.WriteEditableFile("a", content, file.Revision)
			results <- err
		}(content)
	}
	wg.Wait()
	close(results)
	success, conflicts := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrFileConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflicts)
	}
}
