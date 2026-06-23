package commandexec

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type Options struct {
	Command      string
	Cwd          string
	Env          []string
	Shells       []ShellSpec
	Shell        string
	RootID       string
	Session      string
	TerminalCols int
}

type ShellSpec struct {
	Command       string
	Args          []string
	LongShellArgs []string
	CommandPrefix string
}

type Result struct {
	Shell      string
	ExitCode   int
	Duration   time.Duration
	StartedAt  time.Time
	FinishedAt time.Time
	Err        error
}

const (
	defaultTerminalCols = 120
	defaultTerminalRows = 24
	minTerminalCols     = 40
	maxTerminalCols     = 500
)

func terminalColsOrDefault(cols int) uint16 {
	if cols <= 0 {
		return defaultTerminalCols
	}
	if cols < minTerminalCols {
		cols = minTerminalCols
	}
	if cols > maxTerminalCols {
		cols = maxTerminalCols
	}
	return uint16(cols)
}

func terminalRowsOrDefault(rows int) uint16 {
	if rows <= 0 {
		rows = defaultTerminalRows
	}
	if rows < 4 {
		rows = 4
	}
	if rows > 60 {
		rows = 60
	}
	return uint16(rows)
}

type Process interface {
	Output() <-chan []byte
	WriteInput([]byte) (int, error)
	Resize(cols, rows int) error
	Interrupt() error
	Terminate() error
	KillTree() error
	Wait() Result
}

func Start(ctx context.Context, opts Options) (Process, error) {
	command := strings.TrimSpace(opts.Command)
	if command == "" {
		return nil, errors.New("command required")
	}
	cwd := strings.TrimSpace(opts.Cwd)
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return nil, err
		}
	}
	absCwd, err := filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}
	spec, ok := ResolveConfiguredShell(opts.Shells, opts.Shell)
	if !ok {
		if len(normalizeShells(opts.Shells)) > 0 {
			return nil, errors.New("no configured shell found")
		}
		spec = ShellSpec{Command: DefaultShell()}
	}
	if runtime.GOOS != "windows" {
		shell, args, err := shellCommand(command, opts.Shells, opts.Shell)
		if err != nil {
			return nil, err
		}
		cmd := exec.CommandContext(ctx, shell, args...)
		cmd.Dir = absCwd
		cmd.Env = commandEnv(opts.Env)
		return startPlatformProcess(ctx, cmd, shell, opts.TerminalCols)
	}
	shell, args := interactiveShellCommand(spec)
	if shell == "" {
		return nil, errors.New("no configured shell found")
	}
	if shouldUseWindowsPipeFallback(shell) {
		shell, args, err := shellCommand(command, opts.Shells, opts.Shell)
		if err != nil {
			return nil, err
		}
		cmd := exec.CommandContext(ctx, shell, args...)
		cmd.Dir = absCwd
		cmd.Env = commandEnv(opts.Env)
		return startPlatformProcess(ctx, cmd, shell, opts.TerminalCols)
	}
	script := interactiveShellScript(spec, command)
	if strings.TrimSpace(script) == "" {
		return nil, errors.New("command required")
	}
	cmd := exec.CommandContext(ctx, shell, args...)
	cmd.Dir = absCwd
	cmd.Env = commandEnv(opts.Env)
	proc, err := startPlatformProcess(ctx, cmd, shell, opts.TerminalCols)
	if err != nil {
		shell, args, shellErr := shellCommand(command, opts.Shells, opts.Shell)
		if shellErr != nil {
			return nil, shellErr
		}
		cmd := exec.CommandContext(ctx, shell, args...)
		cmd.Dir = absCwd
		cmd.Env = commandEnv(opts.Env)
		return startPlatformProcess(ctx, cmd, shell, opts.TerminalCols)
	}
	go func() {
		_, _ = proc.WriteInput([]byte(script))
	}()
	return proc, nil
}

func shouldUseWindowsPipeFallback(shell string) bool {
	return runtime.GOOS == "windows"
}

func interactiveShellCommand(spec ShellSpec) (string, []string) {
	shell := strings.TrimSpace(spec.Command)
	base := strings.ToLower(filepath.Base(shell))
	if runtime.GOOS == "windows" {
		switch base {
		case "powershell.exe", "powershell", "pwsh.exe", "pwsh":
			return shell, []string{"-NoLogo", "-NoProfile"}
		case "cmd.exe", "cmd":
			return shell, []string{"/Q", "/K"}
		case "wsl.exe", "wsl":
			return shell, []string{"--exec", "bash", "-i"}
		case "bash.exe", "bash":
			return shell, []string{"-i"}
		default:
			return shell, nil
		}
	}
	switch base {
	case "bash", "zsh", "fish", "sh":
		return shell, []string{"-i"}
	default:
		return shell, nil
	}
}

func interactiveShellScript(spec ShellSpec, command string) string {
	base := strings.ToLower(filepath.Base(spec.Command))
	if runtime.GOOS == "windows" {
		switch base {
		case "powershell.exe", "powershell", "pwsh.exe", "pwsh":
			prefix := strings.TrimSpace(spec.CommandPrefix)
			if prefix == "" {
				prefix = strings.TrimSpace(windowsPowerShellCommand(""))
			}
			if prefix != "" {
				prefix += " "
			}
			return prefix + command + "\r\n" +
				"$mindfsExit = if ($global:LASTEXITCODE -ne $null) { $global:LASTEXITCODE } elseif ($?) { 0 } else { 1 }; exit $mindfsExit\r\n"
		case "cmd.exe", "cmd":
			prefix := strings.TrimSpace(spec.CommandPrefix)
			if prefix == "" {
				prefix = "chcp 65001 >NUL &"
			}
			return prefix + " " + command + "\r\nexit /b %ERRORLEVEL%\r\n"
		default:
			return command + "\nexit $?\n"
		}
	}
	return command + "\nexit $?\n"
}

func shellCommand(command string, shells []ShellSpec, requestedShell ...string) (string, []string, error) {
	spec, ok := ResolveConfiguredShell(shells, requestedShell...)
	if !ok {
		if len(normalizeShells(shells)) > 0 {
			return "", nil, errors.New("no configured shell found")
		}
		spec = ShellSpec{Command: DefaultShell()}
	}
	shell := spec.Command
	if len(spec.Args) > 0 {
		return shell, append(append([]string(nil), spec.Args...), shellCommandPayload(spec, command)), nil
	}
	if runtime.GOOS == "windows" {
		if strings.EqualFold(filepath.Base(shell), "cmd.exe") {
			return shell, []string{"/D", "/S", "/C", shellCommandPayload(spec, command)}, nil
		}
		return shell, []string{"-NoLogo", "-NoProfile", "-Command", shellCommandPayload(spec, command)}, nil
	}
	switch strings.ToLower(filepath.Base(shell)) {
	case "bash", "zsh":
		return shell, []string{"-ic", command}, nil
	case "fish":
		return shell, []string{"-i", "-c", command}, nil
	}
	return shell, []string{"-lc", command}, nil
}

func shellCommandPayload(spec ShellSpec, command string) string {
	if strings.TrimSpace(spec.CommandPrefix) != "" {
		return strings.TrimSpace(spec.CommandPrefix) + " " + command
	}
	if runtime.GOOS != "windows" {
		return command
	}
	base := strings.ToLower(filepath.Base(spec.Command))
	if base == "cmd.exe" || base == "cmd" {
		return "chcp 65001 >NUL & " + command
	}
	if base == "powershell.exe" || base == "powershell" || base == "pwsh.exe" || base == "pwsh" {
		return windowsPowerShellCommand(command)
	}
	return command
}

func windowsPowerShellCommand(command string) string {
	return "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = [Console]::OutputEncoding; $OutputEncoding = [Console]::OutputEncoding; " + command
}

func DefaultShell() string {
	return ResolveShell(nil)
}

func ResolveShell(shells []ShellSpec) string {
	if shell, ok := ResolveConfiguredShell(shells); ok {
		return shell.Command
	}
	if runtime.GOOS == "windows" {
		if path, err := exec.LookPath("pwsh"); err == nil {
			return path
		}
		if path, err := exec.LookPath("powershell.exe"); err == nil {
			return path
		}
		return "cmd.exe"
	}
	shell := strings.TrimSpace(os.Getenv("SHELL"))
	if shell == "" {
		shell = "/bin/sh"
	}
	return shell
}

func ResolveConfiguredShell(shells []ShellSpec, requestedShell ...string) (ShellSpec, bool) {
	normalized := normalizeShells(shells)
	if requested := strings.TrimSpace(firstString(requestedShell)); requested != "" {
		for _, configured := range normalized {
			if !shellMatchesRequest(configured, requested) {
				continue
			}
			if resolved := resolveConfiguredShell(configured.Command); resolved != "" {
				configured.Command = resolved
				return configured, true
			}
			return ShellSpec{}, false
		}
		return ShellSpec{}, false
	}
	for _, configured := range normalized {
		if resolved := resolveConfiguredShell(configured.Command); resolved != "" {
			configured.Command = resolved
			return configured, true
		}
	}
	return ShellSpec{}, false
}

func firstString(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func shellMatchesRequest(shell ShellSpec, requested string) bool {
	command := strings.TrimSpace(shell.Command)
	if command == requested {
		return true
	}
	if strings.EqualFold(command, requested) {
		return true
	}
	if resolved := resolveConfiguredShell(command); resolved != "" && strings.EqualFold(resolved, requested) {
		return true
	}
	return false
}

func normalizeShells(shells []ShellSpec) []ShellSpec {
	out := make([]ShellSpec, 0, len(shells))
	for _, shell := range shells {
		if trimmed := strings.TrimSpace(shell.Command); trimmed != "" {
			shell.Command = trimmed
			out = append(out, shell)
		}
	}
	return out
}

func resolveConfiguredShell(command string) string {
	command = strings.TrimSpace(command)
	if command == "" {
		return ""
	}
	if filepath.IsAbs(command) {
		if info, err := os.Stat(command); err == nil && !info.IsDir() {
			return command
		}
		return ""
	}
	if path, err := exec.LookPath(command); err == nil {
		return path
	}
	return ""
}

func commandEnv(extra []string) []string {
	env := os.Environ()
	env = append(env,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"CLICOLOR=1",
		"FORCE_COLOR=1",
		"CLICOLOR_FORCE=1",
	)
	env = append(env, extra...)
	return env
}
