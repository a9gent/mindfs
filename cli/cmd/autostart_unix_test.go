//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLaunchAgentContentEscapesArguments(t *testing.T) {
	content := launchAgentContent("/Applications/Mind & FS/mindfs", []string{"--agent-config", "/tmp/a<b.json"}, "/tmp/mindfs.log")
	for _, expected := range []string{"<key>RunAtLoad</key><true/>", "/Applications/Mind &amp; FS/mindfs", "/tmp/a&lt;b.json"} {
		if !strings.Contains(content, expected) {
			t.Errorf("launch agent does not contain %q:\n%s", expected, content)
		}
	}
	if strings.Contains(content, "ProcessType") || strings.Contains(content, "Background") {
		t.Fatalf("launch agent should use launchd's default Standard process type:\n%s", content)
	}
}

func TestSystemdUnitQuotesExecutableAndArguments(t *testing.T) {
	content := systemdUnitContent("/opt/Mind FS/mindfs", []string{"--notify-script", `/tmp/a"b`})
	for _, expected := range []string{`ExecStart="/opt/Mind FS/mindfs"`, `"/tmp/a\"b"`, "Restart=on-failure"} {
		if !strings.Contains(content, expected) {
			t.Errorf("systemd unit does not contain %q:\n%s", expected, content)
		}
	}
}

func TestInstallAndRemovePlatformAutoStart(t *testing.T) {
	home := t.TempDir()
	configHome := filepath.Join(home, "config")
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("PATH", "")

	location, err := installPlatformAutoStart("/opt/mindfs", []string{"--internal-autostart"}, filepath.Join(home, "mindfs.log"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(location); err != nil {
		t.Fatalf("startup entry %q was not created: %v", location, err)
	}
	if runtime.GOOS == "linux" {
		link := filepath.Join(configHome, "systemd", "user", "default.target.wants", "mindfs.service")
		if target, err := os.Readlink(link); err != nil || target != location {
			t.Fatalf("systemd enable link = %q, %v; want %q", target, err, location)
		}
	}
	if err := removePlatformAutoStart(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(location); !os.IsNotExist(err) {
		t.Fatalf("startup entry still exists after removal: %v", err)
	}
}
