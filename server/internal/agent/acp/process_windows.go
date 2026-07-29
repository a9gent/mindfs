//go:build windows

package acp

import (
	"os"
	"os/exec"
	"syscall"
)

func killProcessTree(proc *os.Process) error {
	if proc == nil {
		return nil
	}
	return proc.Kill()
}

func configurePlatformProcessCommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windowsACPProcessCreationFlags(),
	}
}
