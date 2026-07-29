package main

import "os/exec"

func windowsBrowserCreationFlags() uint32 {
	return windowsCreateNoWindow
}

func configureBrowserCommand(cmd *exec.Cmd) {
	configurePlatformBrowserCommand(cmd)
}
