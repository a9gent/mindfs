package testutil

import (
	"os"
	"testing"
)

func TestIsolateUserDirsRestoresParentEnvironment(t *testing.T) {
	parent := t.TempDir()
	IsolateUserDirs(t, parent)
	parentHome, _ := os.UserHomeDir()
	parentConfig, _ := os.UserConfigDir()
	parentCache, _ := os.UserCacheDir()
	t.Run("nested", func(t *testing.T) {
		child := t.TempDir()
		IsolateUserDirs(t, child)
		for _, resolve := range []func() (string, error){os.UserHomeDir, os.UserConfigDir, os.UserCacheDir} {
			path, err := resolve()
			if err != nil {
				t.Fatal(err)
			}
			RequireWithin(t, child, path)
		}
	})
	home, _ := os.UserHomeDir()
	config, _ := os.UserConfigDir()
	cache, _ := os.UserCacheDir()
	if home != parentHome || config != parentConfig || cache != parentCache {
		t.Fatal("nested test did not restore user directories")
	}
}
