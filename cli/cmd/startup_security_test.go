package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStartupConfigKeepsPairingSetting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"e2ee":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadStartupConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	var enabled bool
	applyStartupConfig(cfg, nil, nil, nil, &enabled, nil, nil, nil, nil, nil, nil, nil, nil)
	if !enabled {
		t.Fatal("startup configuration lost the pairing option")
	}
	enabled = false
	applyStartupConfig(cfg, map[string]bool{"e2ee": true}, nil, nil, &enabled, nil, nil, nil, nil, nil, nil, nil, nil)
	if enabled {
		t.Fatal("explicit command-line settings must override the config file")
	}
}
