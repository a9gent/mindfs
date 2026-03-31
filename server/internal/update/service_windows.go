//go:build windows

package update

import "os/exec"

func configureRestartCommand(cmd *exec.Cmd) {
	_ = cmd
}
