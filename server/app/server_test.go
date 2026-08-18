package app

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/fs"
)

func TestResolveStaticDirFromExecutablePrefersBuiltWebDist(t *testing.T) {
	root := t.TempDir()
	exeDir := filepath.Join(root, "bin")
	builtWeb := filepath.Join(exeDir, "web", "dist")
	releaseWeb := filepath.Join(exeDir, "web")
	installedWeb := filepath.Join(root, "share", "mindfs", "web")
	writeFrontendAssets(t, builtWeb)
	writeFrontendAssets(t, releaseWeb)
	writeFrontendAssets(t, installedWeb)

	got := resolveStaticDirFromExecutable(filepath.Join(exeDir, "mindfs.exe"))
	if got != builtWeb {
		t.Fatalf("resolveStaticDirFromExecutable() = %q, want %q", got, builtWeb)
	}
}

func TestResolveStaticDirFromExecutableFallsBackToReleaseArchiveLayout(t *testing.T) {
	root := t.TempDir()
	exeDir := filepath.Join(root, "bin")
	releaseWeb := filepath.Join(exeDir, "web")
	installedWeb := filepath.Join(root, "share", "mindfs", "web")
	writeFrontendAssets(t, releaseWeb)
	writeFrontendAssets(t, installedWeb)

	got := resolveStaticDirFromExecutable(filepath.Join(exeDir, "mindfs.exe"))
	if got != releaseWeb {
		t.Fatalf("resolveStaticDirFromExecutable() = %q, want %q", got, releaseWeb)
	}
}

func TestResolveStaticDirFromExecutableFallsBackToInstalledLayout(t *testing.T) {
	root := t.TempDir()
	exeDir := filepath.Join(root, "bin")
	installedWeb := filepath.Join(root, "share", "mindfs", "web")
	writeFrontendAssets(t, installedWeb)

	got := resolveStaticDirFromExecutable(filepath.Join(exeDir, "mindfs.exe"))
	if got != installedWeb {
		t.Fatalf("resolveStaticDirFromExecutable() = %q, want %q", got, installedWeb)
	}
}

func TestResolveStaticDirFromExecutableUsesBuiltWebDistWhenSourceWebIsPresent(t *testing.T) {
	root := t.TempDir()
	sourceWeb := filepath.Join(root, "web")
	builtWeb := filepath.Join(sourceWeb, "dist")
	mkdirAll(t, sourceWeb)
	if err := os.WriteFile(filepath.Join(sourceWeb, "index.html"), []byte("source"), 0o644); err != nil {
		t.Fatalf("write source index: %v", err)
	}
	writeFrontendAssets(t, builtWeb)

	got := resolveStaticDirFromExecutable(filepath.Join(root, "mindfs"))
	if got != builtWeb {
		t.Fatalf("resolveStaticDirFromExecutable() = %q, want %q", got, builtWeb)
	}
}

func TestAutoAddExternalProjectRootsSkipsGitWorktrees(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not found")
	}
	workspace := t.TempDir()
	mainRoot := filepath.Join(workspace, "mindfs")
	mkdirAll(t, mainRoot)
	runAppTestGit(t, mainRoot, "init")
	runAppTestGit(t, mainRoot, "config", "user.email", "test@example.com")
	runAppTestGit(t, mainRoot, "config", "user.name", "Test User")
	if err := os.WriteFile(filepath.Join(mainRoot, "README.md"), []byte("base\n"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}
	runAppTestGit(t, mainRoot, "add", "README.md")
	runAppTestGit(t, mainRoot, "commit", "-m", "initial")
	runAppTestGit(t, mainRoot, "checkout", "-b", "task-1")
	runAppTestGit(t, mainRoot, "checkout", "-")
	worktreeRoot := filepath.Join(mainRoot, ".worktree", "task-1")
	runAppTestGit(t, mainRoot, "worktree", "add", worktreeRoot, "task-1")
	worktreeSubdir := filepath.Join(worktreeRoot, "src")
	mkdirAll(t, worktreeSubdir)

	codexHome := filepath.Join(workspace, "codex-home")
	mkdirAll(t, codexHome)
	globalState := map[string]any{
		"project-order": []string{mainRoot, worktreeRoot, worktreeSubdir},
	}
	payload, err := json.Marshal(globalState)
	if err != nil {
		t.Fatalf("marshal global state: %v", err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, ".codex-global-state.json"), payload, 0o644); err != nil {
		t.Fatalf("write global state: %v", err)
	}
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("HOME", filepath.Join(workspace, "home"))
	t.Setenv("TMPDIR", filepath.Join(workspace, "tmp"))

	registry := fs.NewRegistry(filepath.Join(workspace, "registry.json"))
	autoAddExternalProjectRoots(registry, nil)

	roots := registry.List()
	if len(roots) != 1 {
		t.Fatalf("roots len = %d, want 1: %#v", len(roots), roots)
	}
	if agent.NormalizeComparablePath(roots[0].RootPath) != agent.NormalizeComparablePath(mainRoot) {
		t.Fatalf("root path = %q, want %q", roots[0].RootPath, mainRoot)
	}
	if strings.Contains(roots[0].RootPath, ".worktree") {
		t.Fatalf("worktree was added as root: %#v", roots[0])
	}
}

func writeFrontendAssets(t *testing.T, path string) {
	t.Helper()
	mkdirAll(t, path)
	for _, name := range []string{"index.html", "favicon.svg"} {
		if err := os.WriteFile(filepath.Join(path, name), []byte(name), 0o644); err != nil {
			t.Fatalf("write %s: %v", filepath.Join(path, name), err)
		}
	}
}

func runAppTestGit(t *testing.T, root string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out)
}

func mkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}
