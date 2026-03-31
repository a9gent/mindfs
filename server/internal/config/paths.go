package config

import (
	"os"
	"path/filepath"
)

// MindFSConfigDir returns the user-level config directory for MindFS.
// Example: ~/.config/mindfs (Linux/macOS), %AppData%/mindfs (Windows).
func MindFSConfigDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "mindfs"), nil
}

// MindFSInstallDir returns the installed shared-data directory for MindFS
// when the executable lives under PREFIX/bin.
func MindFSInstallDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	prefix := filepath.Dir(filepath.Dir(exe))
	return filepath.Join(prefix, "share", "mindfs"), nil
}
