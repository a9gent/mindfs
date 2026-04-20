//go:build windows

package acp

import (
	"os"
	"os/exec"
)

func killProcessTree(proc *os.Process) error {
	if proc == nil {
		return nil
	}
	return proc.Kill()
}

func configurePlatformProcessCommand(cmd *exec.Cmd) {
	_ = cmd
}
