package agent

import (
	"os"
	"path/filepath"
	"strings"
)

func EnsureStableWorkDir(kind, agentName string) (string, error) {
	base := filepath.Join(os.TempDir(), "mindfs-"+strings.TrimSpace(kind))
	if err := os.MkdirAll(base, 0o755); err != nil {
		return "", err
	}
	name := strings.TrimSpace(agentName)
	if name == "" {
		name = "default"
	}
	path := filepath.Join(base, name)
	if err := os.MkdirAll(path, 0o755); err != nil {
		return "", err
	}
	return path, nil
}
