package agent

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type ShellStatus struct {
	ID              string   `json:"id"`
	Name            string   `json:"name,omitempty"`
	Label           string   `json:"label"`
	Command         string   `json:"command"`
	ResolvedCommand string   `json:"resolved_command,omitempty"`
	Args            []string `json:"args,omitempty"`
	LongShellArgs   []string `json:"longShellArgs,omitempty"`
	Default         bool     `json:"default,omitempty"`
}

func (p *Pool) AvailableShells() []ShellStatus {
	if p == nil {
		return nil
	}
	cfg := p.Config()
	out := make([]ShellStatus, 0, len(cfg.Shells))
	for _, shell := range cfg.Shells {
		resolved, ok := resolveShellCommand(shell.Command)
		if !ok {
			continue
		}
		status := ShellStatus{
			ID:              shell.Command,
			Name:            shell.Name,
			Label:           shellDisplayName(shell),
			Command:         shell.Command,
			ResolvedCommand: resolved,
			Args:            append([]string(nil), shell.Args...),
			LongShellArgs:   append([]string(nil), shell.LongShellArgs...),
		}
		if len(out) == 0 {
			status.Default = true
		}
		out = append(out, status)
	}
	return out
}

func shellDisplayName(shell Shell) string {
	if name := strings.TrimSpace(shell.Name); name != "" {
		return name
	}
	return shellLabelFromCommand(shell.Command)
}

func resolveShellCommand(command string) (string, bool) {
	command = strings.TrimSpace(command)
	if command == "" {
		return "", false
	}
	if filepath.IsAbs(command) {
		info, err := os.Stat(command)
		if err == nil && !info.IsDir() {
			return command, true
		}
		return "", false
	}
	path, err := exec.LookPath(command)
	if err != nil {
		return "", false
	}
	return path, true
}

func shellLabelFromCommand(command string) string {
	base := filepath.Base(strings.ReplaceAll(strings.TrimSpace(command), "\\", "/"))
	if base == "" || base == "." {
		return "shell"
	}
	return strings.TrimSuffix(base, filepath.Ext(base))
}
