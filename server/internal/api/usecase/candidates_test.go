package usecase

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	rootfs "mindfs/server/internal/fs"
)

func TestFileCandidateProviderSearch(t *testing.T) {
	rootDir := t.TempDir()
	mustWriteFile(t, filepath.Join(rootDir, "design", "18-view-plugin.md"), "a")
	mustWriteFile(t, filepath.Join(rootDir, "design", "14-json-render-refactoring.md"), "a")
	mustWriteFile(t, filepath.Join(rootDir, "node_modules", "pkg", "index.js"), "a")
	mustWriteFile(t, filepath.Join(rootDir, ".git", "config"), "a")
	mustWriteFile(t, filepath.Join(rootDir, ".mindfs", "state.json"), "a")
	mustWriteFile(t, filepath.Join(rootDir, ".DS_Store"), "a")
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)

	provider := NewFileCandidateProvider()
	items, err := provider.Search(context.Background(), root, "", "design")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d: %#v", len(items), items)
	}
	if items[0].Name != "design/18-view-plugin.md" {
		t.Fatalf("expected shorter matching path first, got %q", items[0].Name)
	}
	for _, item := range items {
		switch item.Name {
		case "node_modules/pkg/index.js", ".git/config", ".mindfs/state.json", ".DS_Store":
			t.Fatalf("unexpected filtered path in results: %q", item.Name)
		}
	}
}

func TestSkillCandidateProviderSearch(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	rootDir := t.TempDir()
	mustWriteFile(t, filepath.Join(homeDir, ".codex", "skills", "status", "SKILL.md"), "---\nname: status\ndescription: Home status skill\n---\n")
	mustWriteFile(t, filepath.Join(homeDir, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Shared review skill\n---\n")
	mustWriteFile(t, filepath.Join(rootDir, ".codex", "skills", "status", "SKILL.md"), "---\nname: status\ndescription: Root status skill\n---\n")
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)

	provider := NewSkillCandidateProvider()
	items, err := provider.Search(context.Background(), root, "codex", "")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 unique items, got %d: %#v", len(items), items)
	}
	if items[0].Name != "review" && items[0].Name != "status" {
		t.Fatalf("unexpected first item: %#v", items[0])
	}
	descriptionByName := make(map[string]string, len(items))
	for _, item := range items {
		descriptionByName[item.Name] = item.Description
	}
	if got := descriptionByName["status"]; got != "Home status skill" {
		t.Fatalf("expected first scanned status skill to win, got %q", got)
	}
	if got := descriptionByName["review"]; got != "Shared review skill" {
		t.Fatalf("unexpected review description: %q", got)
	}
}

func mustWriteFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q): %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}
