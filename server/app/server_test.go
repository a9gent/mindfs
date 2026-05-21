package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveStaticDirFromExecutablePrefersReleaseArchiveLayout(t *testing.T) {
	root := t.TempDir()
	exeDir := filepath.Join(root, "bin")
	releaseWeb := filepath.Join(exeDir, "web")
	installedWeb := filepath.Join(root, "share", "mindfs", "web")
	mkdirAll(t, releaseWeb)
	mkdirAll(t, installedWeb)

	got := resolveStaticDirFromExecutable(filepath.Join(exeDir, "mindfs.exe"), false)
	if got != releaseWeb {
		t.Fatalf("resolveStaticDirFromExecutable() = %q, want %q", got, releaseWeb)
	}
}

func TestResolveStaticDirFromExecutableFallsBackToInstalledLayout(t *testing.T) {
	root := t.TempDir()
	exeDir := filepath.Join(root, "bin")
	installedWeb := filepath.Join(root, "share", "mindfs", "web")
	mkdirAll(t, installedWeb)

	got := resolveStaticDirFromExecutable(filepath.Join(exeDir, "mindfs.exe"), false)
	if got != installedWeb {
		t.Fatalf("resolveStaticDirFromExecutable() = %q, want %q", got, installedWeb)
	}
}

func mkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}
