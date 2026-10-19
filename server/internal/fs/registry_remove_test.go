package fs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRemoveUnregistersRootWhoseIDDiffersFromDirectory(t *testing.T) {
	base := t.TempDir()
	registryPath := filepath.Join(base, "registry.json")
	target := filepath.Join(base, "backups")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}

	// A directory renamed after registration keeps an ID that no longer matches
	// its basename. The HTTP API addresses roots by path, so removal must too,
	// otherwise such a root can never be unregistered.
	record := RootInfo{
		ID:           "jp-backups",
		Name:         "jp-backups",
		RootPath:     target,
		MetaLocation: MetaLocationProject,
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}
	payload, err := json.Marshal(map[string]any{"dirs": []RootInfo{record}, "order": []string{record.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(registryPath, payload, 0o600); err != nil {
		t.Fatal(err)
	}

	registry := NewRegistry(registryPath)
	if err := registry.Load(); err != nil {
		t.Fatal(err)
	}
	removed, err := registry.Remove(target)
	if err != nil {
		t.Fatalf("remove by recorded path failed: %v", err)
	}
	if removed.ID != "jp-backups" {
		t.Fatalf("removed = %+v, want jp-backups", removed)
	}
	if left := registry.List(); len(left) != 0 {
		t.Fatalf("in-memory roots left: %+v", left)
	}

	reloaded := NewRegistry(registryPath)
	if err := reloaded.Load(); err != nil {
		t.Fatal(err)
	}
	if left := reloaded.List(); len(left) != 0 {
		t.Fatalf("removal not persisted: %+v", left)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("removal must not touch the directory itself: %v", err)
	}
}

func TestRemoveStillRejectsUnregisteredPath(t *testing.T) {
	base := t.TempDir()
	registry := NewRegistry(filepath.Join(base, "registry.json"))
	registered := filepath.Join(base, "registered")
	if err := os.Mkdir(registered, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Upsert(registered); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Remove(filepath.Join(base, "elsewhere")); err == nil {
		t.Fatal("removing an unregistered path must fail")
	}
}
