//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

const windowsStillActive = 259

func platformStateDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return base, nil
}

func configureBackgroundCommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windowsBackgroundCreationFlags(),
	}
}

func stopProcess(_ *os.Process, pid int) error {
	if pid <= 0 {
		return os.ErrProcessDone
	}
	cmd := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := cmd.CombinedOutput()
	if err != nil {
		text := strings.ToLower(string(output))
		if strings.Contains(text, "not found") || strings.Contains(text, "no running instance") {
			return os.ErrProcessDone
		}
		return fmt.Errorf("taskkill failed: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

func processExistsPlatform(pid int) bool {
	name, err := processNameForPID(pid)
	return err == nil && name != ""
}

func findListeningMindfsPID(addr string) (int, error) {
	port := "7331"
	if idx := strings.LastIndex(addr, ":"); idx >= 0 && idx+1 < len(addr) {
		port = strings.TrimSpace(addr[idx+1:])
	}
	cmd := exec.Command("netstat", "-ano", "-p", "tcp")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := cmd.Output()
	if err != nil {
		return 0, nil
	}
	lines := strings.Split(string(output), "\n")
	suffixes := []string{":" + port, "]:" + port}
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 5 || !strings.EqualFold(fields[0], "TCP") {
			continue
		}
		localAddr := fields[1]
		state := strings.ToUpper(fields[3])
		if state != "LISTENING" {
			continue
		}
		match := false
		for _, suffix := range suffixes {
			if strings.HasSuffix(localAddr, suffix) {
				match = true
				break
			}
		}
		if !match {
			continue
		}
		pid, err := strconv.Atoi(fields[4])
		if err != nil || pid <= 0 {
			continue
		}
		name, err := processNameForPID(pid)
		if err == nil && strings.EqualFold(name, "mindfs.exe") {
			return pid, nil
		}
	}
	return 0, nil
}

func processNameForPID(pid int) (string, error) {
	if pid <= 0 {
		return "", errors.New("invalid pid")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return "", os.ErrProcessDone
		}
		return "", fmt.Errorf("open process %d: %w", pid, err)
	}
	defer windows.CloseHandle(handle)

	var exitCode uint32
	if err := windows.GetExitCodeProcess(handle, &exitCode); err != nil {
		return "", fmt.Errorf("query process %d exit code: %w", pid, err)
	}
	if exitCode != windowsStillActive {
		return "", os.ErrProcessDone
	}

	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		return "", fmt.Errorf("query process %d image name: %w", pid, err)
	}
	name := filepath.Base(windows.UTF16ToString(buffer[:size]))
	if name == "" {
		return "", os.ErrProcessDone
	}
	return name, nil
}
