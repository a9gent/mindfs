//go:build !windows

package main

import "os/exec"

func configurePlatformBrowserCommand(cmd *exec.Cmd) {
	_ = cmd
}
