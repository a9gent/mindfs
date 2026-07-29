//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

func configurePlatformBrowserCommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windowsBrowserCreationFlags(),
	}
}
