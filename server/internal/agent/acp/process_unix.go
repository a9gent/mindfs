//go:build !windows

package acp

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

type unixProcessTree struct {
	proc *os.Process
}

func startProcessCommand(cmd *exec.Cmd) (processTree, error) {
	cmd.Cancel = func() error { return killProcessTree(cmd.Process) }
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &unixProcessTree{proc: cmd.Process}, nil
}

func (t *unixProcessTree) Kill() error  { return killProcessTree(t.proc) }
func (t *unixProcessTree) Close() error { return nil }

func platformProcessDiagnostic(pid int) string {
	pgid, err := syscall.Getpgid(pid)
	if err != nil {
		return fmt.Sprintf("pgid_error=%q", err.Error())
	}
	return fmt.Sprintf("pgid=%d", pgid)
}

func killProcessTree(proc *os.Process) error {
	if proc == nil {
		return nil
	}
	if err := syscall.Kill(-proc.Pid, syscall.SIGKILL); err == nil {
		return nil
	}
	return proc.Kill()
}

func configurePlatformProcessCommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
