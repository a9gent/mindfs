//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func installPlatformAutoStart(exe string, args []string, logPath string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "darwin" {
		path := filepath.Join(home, "Library", "LaunchAgents", "com.a9gent.mindfs.plist")
		content := launchAgentContent(exe, args, logPath)
		if err := writeAutoStartFile(path, content, 0o644); err != nil {
			return "", err
		}
		return path, nil
	}

	configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
	if configHome == "" {
		configHome = filepath.Join(home, ".config")
	}
	unitPath := filepath.Join(configHome, "systemd", "user", "mindfs.service")
	content := systemdUnitContent(exe, args)
	if err := writeAutoStartFile(unitPath, content, 0o644); err != nil {
		return "", err
	}
	wantsDir := filepath.Join(configHome, "systemd", "user", "default.target.wants")
	if err := os.MkdirAll(wantsDir, 0o755); err != nil {
		return "", err
	}
	wantsPath := filepath.Join(wantsDir, "mindfs.service")
	if target, linkErr := os.Readlink(wantsPath); linkErr != nil || target != unitPath {
		if removeErr := os.Remove(wantsPath); removeErr != nil && !os.IsNotExist(removeErr) {
			return "", removeErr
		}
		if linkErr := os.Symlink(unitPath, wantsPath); linkErr != nil {
			return "", linkErr
		}
	}
	if systemctl, lookupErr := exec.LookPath("systemctl"); lookupErr == nil {
		reload := exec.Command(systemctl, "--user", "daemon-reload")
		_ = reload.Run()
		return unitPath, nil
	}
	return unitPath, nil
}

func detectedPlatformShell() string {
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell
	}
	return "/bin/sh"
}

func writeAutoStartFile(path, content string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), mode)
}

func removePlatformAutoStart() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		path := filepath.Join(home, "Library", "LaunchAgents", "com.a9gent.mindfs.plist")
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
	if configHome == "" {
		configHome = filepath.Join(home, ".config")
	}
	paths := []string{
		filepath.Join(configHome, "systemd", "user", "default.target.wants", "mindfs.service"),
		filepath.Join(configHome, "systemd", "user", "mindfs.service"),
		filepath.Join(configHome, "autostart", "mindfs.desktop"),
	}
	for _, path := range paths {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if systemctl, lookupErr := exec.LookPath("systemctl"); lookupErr == nil {
		_ = exec.Command(systemctl, "--user", "daemon-reload").Run()
	}
	return nil
}

func launchAgentContent(exe string, args []string, logPath string) string {
	var arguments strings.Builder
	for _, arg := range append([]string{exe}, args...) {
		arguments.WriteString("    <string>")
		arguments.WriteString(xmlEscape(arg))
		arguments.WriteString("</string>\n")
	}
	return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
		"<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n" +
		"<plist version=\"1.0\">\n<dict>\n" +
		"  <key>Label</key><string>com.a9gent.mindfs</string>\n" +
		"  <key>ProgramArguments</key>\n  <array>\n" + arguments.String() + "  </array>\n" +
		"  <key>RunAtLoad</key><true/>\n" +
		"  <key>StandardOutPath</key><string>" + xmlEscape(logPath) + "</string>\n" +
		"  <key>StandardErrorPath</key><string>" + xmlEscape(logPath) + "</string>\n" +
		"</dict>\n</plist>\n"
}

func systemdUnitContent(exe string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	for _, arg := range append([]string{exe}, args...) {
		parts = append(parts, systemdQuote(arg))
	}
	return "[Unit]\nDescription=MindFS background service\nAfter=network.target\n\n" +
		"[Service]\nType=simple\nExecStart=" + strings.Join(parts, " ") + "\nRestart=on-failure\nRestartSec=3\n\n" +
		"[Install]\nWantedBy=default.target\n"
}

func systemdQuote(value string) string {
	return "\"" + strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "%", "%%").Replace(value) + "\""
}

func xmlEscape(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&apos;").Replace(value)
}
