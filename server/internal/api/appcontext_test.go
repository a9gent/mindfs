package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"mindfs/server/internal/fs"
)

func TestNextSessionWorktreeNameUsesDateAndNextSequence(t *testing.T) {
	now := time.Date(2026, time.July, 30, 15, 30, 0, 0, time.Local)
	got := nextSessionWorktreeName(now, []string{
		"task-12",
		"session-0729-09",
		"session-0730-01",
		"session-0730-03",
		"session-0730-invalid",
	})
	if got != "session-0730-04" {
		t.Fatalf("nextSessionWorktreeName() = %q, want %q", got, "session-0730-04")
	}
}

func TestNextSessionWorktreeNameStartsAtOne(t *testing.T) {
	now := time.Date(2026, time.July, 30, 15, 30, 0, 0, time.Local)
	if got := nextSessionWorktreeName(now, nil); got != "session-0730-01" {
		t.Fatalf("nextSessionWorktreeName() = %q, want %q", got, "session-0730-01")
	}
}

func TestListRootsRemovesDeletedManagedDirWithoutRecreatingIt(t *testing.T) {
	parent := t.TempDir()
	registry := fs.NewRegistry(filepath.Join(parent, "registry.json"))
	projectPath := filepath.Join(parent, "project")
	if err := os.Mkdir(projectPath, 0o755); err != nil {
		t.Fatalf("Mkdir project returned error: %v", err)
	}
	if _, err := registry.Upsert(projectPath); err != nil {
		t.Fatalf("Upsert returned error: %v", err)
	}
	if err := os.RemoveAll(projectPath); err != nil {
		t.Fatalf("RemoveAll project returned error: %v", err)
	}

	app := &AppContext{Dirs: registry}
	if roots := app.ListRoots(); len(roots) != 0 {
		t.Fatalf("ListRoots returned %d roots, want 0", len(roots))
	}
	if roots := registry.List(); len(roots) != 0 {
		t.Fatalf("registry still has %d roots, want 0", len(roots))
	}
	if _, err := os.Stat(projectPath); !os.IsNotExist(err) {
		t.Fatalf("deleted project was recreated or stat failed unexpectedly: %v", err)
	}
}

func TestGetRootContextRemovesDeletedManagedDirWithoutRecreatingIt(t *testing.T) {
	parent := t.TempDir()
	registry := fs.NewRegistry(filepath.Join(parent, "registry.json"))
	projectPath := filepath.Join(parent, "project")
	if err := os.Mkdir(projectPath, 0o755); err != nil {
		t.Fatalf("Mkdir project returned error: %v", err)
	}
	dir, err := registry.Upsert(projectPath)
	if err != nil {
		t.Fatalf("Upsert returned error: %v", err)
	}
	if err := os.RemoveAll(projectPath); err != nil {
		t.Fatalf("RemoveAll project returned error: %v", err)
	}

	app := &AppContext{Dirs: registry}
	if _, err := app.GetSessionManager(dir.ID); err == nil {
		t.Fatal("GetSessionManager returned nil error for deleted root")
	}
	if roots := registry.List(); len(roots) != 0 {
		t.Fatalf("registry still has %d roots, want 0", len(roots))
	}
	if _, err := os.Stat(projectPath); !os.IsNotExist(err) {
		t.Fatalf("deleted project was recreated or stat failed unexpectedly: %v", err)
	}
}
