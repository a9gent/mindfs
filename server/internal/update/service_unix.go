//go:build !windows

package update

import (
	"io"
	"os/exec"
	"syscall"
)

func startReplacementProcess(_ int, exe string, args []string, stdout, stderr io.Writer, _, _, _, _ string) error {
	cmdArgs := append([]string{"-c", "sleep 1; exec \"$@\"", "mindfs-restart", exe}, args...)
	cmd := exec.Command("/bin/sh", cmdArgs...)
	cmd.Env = append(cmd.Environ(), "MINDFS_INTERNAL_RESTART=1")
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd.Start()
}
