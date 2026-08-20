package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	autoStartSnapshotName = "autostart-environment.json"
	autoStartMarker       = "__MINDFS_ENV_START__"
	autoStartShellTimeout = 5 * time.Second
)

type autoStartSnapshot struct {
	Version     int               `json:"version"`
	OS          string            `json:"os"`
	Shell       string            `json:"shell"`
	CapturedAt  time.Time         `json:"capturedAt"`
	Environment map[string]string `json:"environment"`
}

func autoStartRequested(args []string) bool {
	for _, arg := range args {
		if arg == "-internal-autostart" || arg == "--internal-autostart" ||
			strings.HasPrefix(arg, "-internal-autostart=") || strings.HasPrefix(arg, "--internal-autostart=") {
			return !strings.HasSuffix(strings.ToLower(arg), "=false")
		}
	}
	return false
}

func prepareAutoStartEnvironment() error {
	configDir, err := autoStartConfigDir()
	if err != nil {
		return err
	}
	snapshot, err := readAutoStartSnapshot(filepath.Join(configDir, autoStartSnapshotName))
	if err != nil {
		return err
	}
	applyEnvironment(snapshot.Environment, true)

	shellEnv, err := readShellEnvironment(snapshot.Shell, autoStartShellTimeout)
	if err != nil {
		return fmt.Errorf("load %s environment: %w", displayShell(snapshot.Shell), err)
	}
	applyEnvironment(shellEnv, true)
	return nil
}

func autoStartConfigDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "mindfs"), nil
}

func autoStartConfigured() bool {
	configDir, err := autoStartConfigDir()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(configDir, autoStartSnapshotName))
	return err == nil
}

func saveAutoStartSnapshot(stateDir string) (string, error) {
	path := filepath.Join(stateDir, autoStartSnapshotName)
	snapshot := autoStartSnapshot{
		Version:     1,
		OS:          runtime.GOOS,
		Shell:       currentUserShell(),
		CapturedAt:  time.Now(),
		Environment: environmentMap(os.Environ()),
	}
	payload, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return "", err
	}
	payload = append(payload, '\n')
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(stateDir, 0o700); err != nil && runtime.GOOS != "windows" {
		return "", err
	}
	tmp, err := os.CreateTemp(stateDir, ".autostart-environment-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return "", err
	}
	if _, err := tmp.Write(payload); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" {
		_ = os.Remove(path)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return "", err
	}
	return path, nil
}

func readAutoStartSnapshot(path string) (autoStartSnapshot, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return autoStartSnapshot{}, fmt.Errorf("read environment snapshot: %w", err)
	}
	var snapshot autoStartSnapshot
	if err := json.Unmarshal(payload, &snapshot); err != nil {
		return autoStartSnapshot{}, fmt.Errorf("decode environment snapshot: %w", err)
	}
	if snapshot.Version != 1 {
		return autoStartSnapshot{}, fmt.Errorf("unsupported environment snapshot version %d", snapshot.Version)
	}
	return snapshot, nil
}

func environmentMap(entries []string) map[string]string {
	env := make(map[string]string, len(entries))
	for _, entry := range entries {
		key, value, ok := strings.Cut(entry, "=")
		if ok && key != "" {
			env[key] = value
		}
	}
	return env
}

func applyEnvironment(env map[string]string, preserveSystemValues bool) {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if shouldSkipRestoredEnvironment(key) {
			continue
		}
		if preserveSystemValues && shouldPreserveSystemEnvironment(key) {
			if _, exists := os.LookupEnv(key); exists {
				continue
			}
		}
		_ = os.Setenv(key, env[key])
	}
}

func shouldSkipRestoredEnvironment(key string) bool {
	upper := strings.ToUpper(strings.TrimSpace(key))
	if strings.HasPrefix(upper, "MINDFS_") {
		return true
	}
	switch upper {
	case "PWD", "OLDPWD", "SHLVL", "_",
		"SSH_AUTH_SOCK", "SSH_AGENT_PID",
		"TERM_SESSION_ID", "WINDOWID", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS":
		return true
	default:
		return false
	}
}

func shouldPreserveSystemEnvironment(key string) bool {
	switch strings.ToUpper(strings.TrimSpace(key)) {
	case "HOME", "USER", "LOGNAME", "USERNAME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR":
		return true
	default:
		return false
	}
}

func currentUserShell() string {
	if shell := strings.TrimSpace(os.Getenv("MINDFS_SHELL")); shell != "" {
		return shell
	}
	return detectedPlatformShell()
}

func readShellEnvironment(shell string, timeout time.Duration) (map[string]string, error) {
	shell = strings.TrimSpace(shell)
	if shell == "" {
		return nil, errors.New("shell is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	name, args, nulSeparated := shellEnvironmentCommand(shell)
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = os.Environ()
	output, err := cmd.Output()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("timed out after %s", timeout)
	}
	if err != nil {
		return nil, err
	}
	marker := []byte(autoStartMarker)
	markerAt := bytes.LastIndex(output, marker)
	if markerAt < 0 {
		return nil, errors.New("environment marker not found")
	}
	output = output[markerAt+len(marker):]
	if nulSeparated {
		return parseNulEnvironment(output), nil
	}
	return parseLineEnvironment(output), nil
}

func shellEnvironmentCommand(shell string) (string, []string, bool) {
	base := strings.ToLower(filepath.Base(shell))
	unixCommand := "printf '" + autoStartMarker + "\\0'; env -0"
	if runtime.GOOS == "windows" {
		switch base {
		case "powershell", "powershell.exe", "pwsh", "pwsh.exe":
			script := "$marker='" + autoStartMarker + "'; [Console]::Out.Write($marker + [char]0); Get-ChildItem Env: | ForEach-Object { [Console]::Out.Write($_.Name + '=' + $_.Value + [char]0) }"
			return shell, []string{"-NoLogo", "-NonInteractive", "-Command", script}, true
		case "bash", "bash.exe", "zsh", "zsh.exe", "fish", "fish.exe":
			return shell, []string{"-l", "-i", "-c", unixCommand}, true
		default:
			return shell, []string{"/Q", "/C", "echo " + autoStartMarker + " & set"}, false
		}
	}
	switch base {
	case "bash", "zsh", "fish":
		return shell, []string{"-l", "-i", "-c", unixCommand}, true
	default:
		return shell, []string{"-l", "-c", unixCommand}, true
	}
}

func parseNulEnvironment(output []byte) map[string]string {
	env := make(map[string]string)
	for _, entry := range bytes.Split(output, []byte{0}) {
		key, value, ok := bytes.Cut(entry, []byte{'='})
		if ok && len(key) > 0 {
			env[string(key)] = string(value)
		}
	}
	return env
}

func parseLineEnvironment(output []byte) map[string]string {
	env := make(map[string]string)
	for _, line := range strings.Split(strings.ReplaceAll(string(output), "\r\n", "\n"), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok && key != "" {
			env[key] = value
		}
	}
	return env
}

func displayShell(shell string) string {
	if base := filepath.Base(strings.TrimSpace(shell)); base != "." && base != "" {
		return base
	}
	return "shell"
}

func configureAutoStart(logPath string, args []string) (string, error) {
	configDir, err := autoStartConfigDir()
	if err != nil {
		return "", err
	}
	if _, err := saveAutoStartSnapshot(configDir); err != nil {
		return "", fmt.Errorf("save autostart environment: %w", err)
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	location, err := installPlatformAutoStart(exe, args, logPath)
	if err != nil {
		return "", err
	}
	return location, nil
}

func removeAutoStart() error {
	if err := removePlatformAutoStart(); err != nil {
		return err
	}
	configDir, err := autoStartConfigDir()
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(configDir, autoStartSnapshotName)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func autoStartArguments(addr string, noRelayer, e2ee, webPush, tlsEnabled bool, cert, key, agentConfig, notifyScript string) []string {
	args := []string{"--internal-autostart", "--addr", addr}
	if noRelayer {
		args = append(args, "--no-relayer")
	}
	if e2ee {
		args = append(args, "--e2ee")
	}
	if !webPush {
		args = append(args, "--web-push=false")
	}
	if tlsEnabled {
		args = append(args, "--tls")
	}
	for _, item := range []struct {
		flag  string
		value string
	}{
		{"--cert", cert},
		{"--key", key},
		{"--agent-config", agentConfig},
		{"--notify-script", notifyScript},
	} {
		if value := strings.TrimSpace(item.value); value != "" {
			args = append(args, item.flag, value)
		}
	}
	return args
}
