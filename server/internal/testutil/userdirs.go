// Package testutil contains shared helpers for tests, not application code.
package testutil

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// IsolateUserDirs redirects user files on all supported operating systems.
// XDG_CONFIG_HOME alone does not affect macOS or Windows. Call before creating
// stores or loading configuration; t.Setenv also prevents use in parallel tests.
func IsolateUserDirs(t testing.TB, root string) {
	t.Helper()
	for key, path := range map[string]string{
		"HOME":            root,
		"USERPROFILE":     root,
		"AppData":         filepath.Join(root, "AppData", "Roaming"),
		"LocalAppData":    filepath.Join(root, "AppData", "Local"),
		"XDG_CONFIG_HOME": filepath.Join(root, ".config"),
		"XDG_CACHE_HOME":  filepath.Join(root, ".cache"),
	} {
		t.Setenv(key, path)
	}
	for _, resolve := range []func() (string, error){os.UserHomeDir, os.UserConfigDir, os.UserCacheDir} {
		path, err := resolve()
		if err != nil {
			t.Fatal(err)
		}
		RequireWithin(t, root, path)
	}
}

// RequireWithin fails before a test can write outside its temporary directory.
func RequireWithin(t testing.TB, root, path string) {
	t.Helper()
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		t.Fatalf("test path %q is outside temporary directory %q", path, root)
	}
}
