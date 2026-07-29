package gitview

import (
	"context"
	"os/exec"
)

func newGitCommand(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", args...)
	configureGitCommand(cmd)
	return cmd
}

const (
	windowsGitCreateNewProcessGroup  = uint32(0x00000200)
	windowsGitCreateDefaultErrorMode = uint32(0x04000000)
	windowsGitCreateNoWindow         = uint32(0x08000000)
)

func windowsGitCreationFlags() uint32 {
	return windowsGitCreateNewProcessGroup | windowsGitCreateDefaultErrorMode | windowsGitCreateNoWindow
}
