//go:build !windows

package gitview

import "os/exec"

func configureGitCommand(cmd *exec.Cmd) {
	_ = cmd
}
