//go:build !windows

package main

import (
	"bytes"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func platformStateDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share"), nil
}

func configureBackgroundCommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func stopProcess(proc *os.Process, _ int) error {
	return proc.Signal(syscall.SIGTERM)
}

func processExistsPlatform(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

func findListeningMindfsPID(addr string) (int, error) {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		port = strings.TrimPrefix(addr, ":")
	}
	if strings.TrimSpace(port) == "" {
		port = "7331"
	}

	cmd := exec.Command("lsof", "-nP", "-iTCP:"+port, "-sTCP:LISTEN", "-Fpct")
	output, err := cmd.Output()
	if err != nil {
		return 0, nil
	}

	var pid int
	var command string
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(string(line[1:]))
			command = ""
		case 'c':
			command = string(line[1:])
			if pid > 0 && command == "mindfs" {
				return pid, nil
			}
		}
	}
	return 0, nil
}
