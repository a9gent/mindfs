package usecase

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type ShellHistorySpec struct {
	Command string
}

func SearchSystemShellHistory(ctx context.Context, spec ShellHistorySpec, query string, limit int) []CandidateItem {
	if limit <= 0 {
		limit = maxCandidateItems
	}
	command := strings.TrimSpace(spec.Command)
	if command == "" {
		command = strings.TrimSpace(os.Getenv("SHELL"))
	}
	base := strings.ToLower(filepath.Base(command))
	var paths []string
	switch base {
	case "zsh":
		paths = shellHistoryPaths("HISTFILE", ".zsh_history")
	case "bash":
		paths = shellHistoryPaths("HISTFILE", ".bash_history")
	case "fish":
		paths = fishHistoryPaths()
	case "pwsh", "pwsh.exe", "powershell", "powershell.exe":
		paths = powershellHistoryPaths()
	default:
		if runtime.GOOS == "windows" {
			paths = powershellHistoryPaths()
		} else {
			paths = shellHistoryPaths("HISTFILE", ".zsh_history")
			paths = append(paths, shellHistoryPaths("", ".bash_history")...)
		}
	}
	return searchHistoryFiles(ctx, paths, base, query, limit)
}

func shellHistoryPaths(envKey, fallback string) []string {
	if envKey != "" {
		if value := strings.TrimSpace(os.Getenv(envKey)); value != "" {
			return []string{expandHome(value)}
		}
	}
	var paths []string
	if fallback != "" {
		paths = append(paths, filepath.Join(userHomeDir(), fallback))
	}
	return uniqueStrings(paths)
}

func fishHistoryPaths() []string {
	home := userHomeDir()
	paths := []string{
		filepath.Join(home, ".local", "share", "fish", "fish_history"),
	}
	if runtime.GOOS == "darwin" {
		paths = append(paths, filepath.Join(home, "Library", "Application Support", "fish", "fish_history"))
	}
	return uniqueStrings(paths)
}

func powershellHistoryPaths() []string {
	appData := strings.TrimSpace(os.Getenv("APPDATA"))
	if appData == "" {
		appData = filepath.Join(userHomeDir(), "AppData", "Roaming")
	}
	return uniqueStrings([]string{
		filepath.Join(appData, "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"),
		filepath.Join(appData, "Microsoft", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"),
	})
}

func searchHistoryFiles(ctx context.Context, paths []string, shellBase, query string, limit int) []CandidateItem {
	q := strings.ToLower(strings.TrimSpace(query))
	seen := make(map[string]struct{})
	items := make([]CandidateItem, 0, limit)
	for _, path := range paths {
		for _, command := range readHistoryFile(ctx, path, shellBase) {
			if len(items) >= limit {
				return items
			}
			normalized := normalizeCandidateName(command)
			if normalized == "" {
				continue
			}
			if _, ok := seen[normalized]; ok {
				continue
			}
			seen[normalized] = struct{}{}
			if q != "" && !matchesCandidateName(command, q) {
				continue
			}
			items = append(items, CandidateItem{
				Type:        CandidateTypeCommand,
				Name:        command,
				Description: "shell history",
			})
		}
	}
	return items
}

func readHistoryFile(ctx context.Context, path, shellBase string) []string {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	file, err := os.Open(expandHome(path))
	if err != nil {
		return nil
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var commands []string
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return reverseStrings(commands)
		default:
		}
		if command := cleanSystemHistoryCommand(parseHistoryLine(scanner.Text(), shellBase)); command != "" {
			commands = append(commands, command)
		}
	}
	return reverseStrings(commands)
}

func parseHistoryLine(line, shellBase string) string {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return ""
	}
	switch shellBase {
	case "zsh":
		if strings.HasPrefix(trimmed, ": ") {
			if idx := strings.Index(trimmed, ";"); idx >= 0 && idx+1 < len(trimmed) {
				return strings.TrimSpace(trimmed[idx+1:])
			}
		}
	case "fish":
		if strings.HasPrefix(trimmed, "- cmd:") {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, "- cmd:"))
		}
		return ""
	}
	return trimmed
}

func cleanSystemHistoryCommand(command string) string {
	command = strings.TrimSpace(command)
	if command == "" || isMindFSControlHistoryCommand(command) {
		return ""
	}
	if unwrapped, ok := unwrapMindFSEvalHistoryCommand(command); ok {
		return strings.TrimSpace(unwrapped)
	}
	return command
}

func isMindFSControlHistoryCommand(command string) bool {
	text := strings.TrimSpace(command)
	if text == "" {
		return true
	}
	controlTokens := []string{
		"__MINDFS_CMD_START_",
		"__MINDFS_CMD_END_",
		"__mindfs_status",
		"$global:LASTEXITCODE",
		"[Console]::OutputEncoding",
		"[Console]::InputEncoding",
	}
	for _, token := range controlTokens {
		if strings.Contains(text, token) {
			return true
		}
	}
	lower := strings.ToLower(text)
	return strings.HasPrefix(lower, "command printf ") ||
		strings.HasPrefix(lower, "write-output ") ||
		strings.HasPrefix(lower, "echo __mindfs_cmd_") ||
		strings.HasPrefix(lower, "set -l __mindfs_status ") ||
		strings.HasPrefix(lower, "prompt $s") ||
		strings.HasPrefix(lower, "chcp 65001 ")
}

func unwrapMindFSEvalHistoryCommand(command string) (string, bool) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(command), "eval ")
	if !ok {
		return "", false
	}
	unquoted, rest, ok := readShellSingleQuoted(rest)
	if !ok {
		return "", false
	}
	if strings.TrimSpace(rest) != "</dev/null" {
		return "", false
	}
	return unquoted, true
}

func readShellSingleQuoted(value string) (string, string, bool) {
	value = strings.TrimLeft(value, " \t")
	if !strings.HasPrefix(value, "'") {
		return "", value, false
	}
	var out strings.Builder
	for i := 1; i < len(value); {
		if value[i] != '\'' {
			out.WriteByte(value[i])
			i++
			continue
		}
		if strings.HasPrefix(value[i:], "'\\''") {
			out.WriteByte('\'')
			i += len("'\\''")
			continue
		}
		return out.String(), value[i+1:], true
	}
	return "", value, false
}

func expandHome(path string) string {
	if path == "~" {
		return userHomeDir()
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		return filepath.Join(userHomeDir(), path[2:])
	}
	return path
}

func userHomeDir() string {
	if home, err := os.UserHomeDir(); err == nil {
		return home
	}
	return ""
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func reverseStrings(values []string) []string {
	for i, j := 0, len(values)-1; i < j; i, j = i+1, j-1 {
		values[i], values[j] = values[j], values[i]
	}
	return values
}
