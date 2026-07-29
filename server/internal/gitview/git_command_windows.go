//go:build windows

package gitview

import (
	"os/exec"
	"syscall"
)

func configureGitCommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windowsGitCreationFlags(),
	}
}
