//go:build !windows

package update

import (
	"os/exec"
	"syscall"
)

func configureRestartCommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
