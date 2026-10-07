package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStartupConfigKeepsPairingAndProxySettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"e2ee":true,"trusted-proxies":" 127.0.0.1/32,::1/128 "}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadStartupConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	flags := startupFlags{E2EE: new(bool), TrustedProxies: new(string)}
	applyStartupConfig(cfg, nil, flags)
	if !*flags.E2EE || *flags.TrustedProxies != "127.0.0.1/32,::1/128" {
		t.Fatalf("startup configuration lost security options: e2ee=%v proxies=%q", *flags.E2EE, *flags.TrustedProxies)
	}
	*flags.E2EE, *flags.TrustedProxies = false, ""
	applyStartupConfig(cfg, map[string]bool{"e2ee": true, "trusted-proxies": true}, flags)
	if *flags.E2EE || *flags.TrustedProxies != "" {
		t.Fatal("explicit command-line settings must override the config file")
	}
}
