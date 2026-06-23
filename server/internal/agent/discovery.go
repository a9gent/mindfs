package agent

import (
	"bufio"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// DiscoverExternalProjectPaths returns project roots known to Codex and Claude.
func DiscoverExternalProjectPaths() []string {
	seen := make(map[string]struct{})
	var paths []string
	add := func(path string) {
		normalized := NormalizeComparablePath(path)
		if normalized == "" {
			return
		}
		info, err := os.Stat(normalized)
		if err != nil || !info.IsDir() {
			return
		}
		if _, ok := seen[normalized]; ok {
			return
		}
		seen[normalized] = struct{}{}
		paths = append(paths, normalized)
	}

	for _, path := range discoverCodexProjectPaths() {
		add(path)
	}
	for _, path := range discoverClaudeProjectPaths() {
		add(path)
	}
	return paths
}

func discoverCodexProjectPaths() []string {
	codexHome := codexHomeDir()
	if codexHome == "" {
		return nil
	}
	var paths []string
	paths = append(paths, readCodexGlobalStateProjects(filepath.Join(codexHome, ".codex-global-state.json"))...)
	if len(paths) == 0 {
		paths = append(paths, readCodexConfigProjects(filepath.Join(codexHome, "config.toml"))...)
	}
	if len(paths) == 0 {
		paths = append(paths, readCodexSessionCwds(filepath.Join(codexHome, "sessions"))...)
	}
	return paths
}

func codexHomeDir() string {
	if value := strings.TrimSpace(os.Getenv("CODEX_HOME")); value != "" {
		return value
	}
	home := UserHomeDir()
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".codex")
}

func readCodexGlobalStateProjects(path string) []string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var state map[string]any
	if err := json.Unmarshal(raw, &state); err != nil {
		log.Printf("[agent/discovery] codex global state parse failed path=%s err=%v", path, err)
		return nil
	}
	labels := make(map[string]struct{})
	var paths []string
	appendStrings := func(value any) {
		items, _ := value.([]any)
		for _, item := range items {
			path := strings.TrimSpace(asString(item))
			if path == "" {
				continue
			}
			if _, ok := labels[path]; ok {
				continue
			}
			labels[path] = struct{}{}
			paths = append(paths, path)
		}
	}
	appendStrings(state["project-order"])
	appendStrings(state["electron-saved-workspace-roots"])
	return paths
}

func readCodexConfigProjects(path string) []string {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()

	var paths []string
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.HasPrefix(line, "[projects.") || !strings.HasSuffix(line, "]") {
			continue
		}
		value := strings.TrimSuffix(strings.TrimPrefix(line, "[projects."), "]")
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		if value != "" {
			paths = append(paths, value)
		}
	}
	return paths
}

func readCodexSessionCwds(root string) []string {
	var paths []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil || d == nil || d.IsDir() || filepath.Ext(path) != ".jsonl" {
			return nil
		}
		if cwd := readCodexSessionCwd(path); cwd != "" {
			paths = append(paths, cwd)
		}
		return nil
	})
	return paths
}

func readCodexSessionCwd(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024), 1024*1024)
	for scanner.Scan() {
		var raw map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &raw); err != nil {
			continue
		}
		payload, _ := raw["payload"].(map[string]any)
		if raw["type"] == "turn_context" && payload != nil {
			return strings.TrimSpace(asString(payload["cwd"]))
		}
		if raw["type"] == "session_meta" && payload != nil {
			if cwd := strings.TrimSpace(asString(payload["cwd"])); cwd != "" {
				return cwd
			}
		}
	}
	return ""
}

func discoverClaudeProjectPaths() []string {
	home := UserHomeDir()
	if home == "" {
		return nil
	}
	root := filepath.Join(home, ".claude", "projects")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var paths []string
	for _, entry := range entries {
		if entry == nil || !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		if found := readClaudeProjectIndexPaths(filepath.Join(dir, "sessions-index.json")); len(found) > 0 {
			paths = append(paths, found...)
			continue
		}
		paths = append(paths, readClaudeProjectJSONLCwds(dir)...)
	}
	return paths
}

func readClaudeProjectIndexPaths(path string) []string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var index struct {
		OriginalPath string `json:"originalPath"`
		Entries      []struct {
			ProjectPath string `json:"projectPath"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(raw, &index); err != nil {
		log.Printf("[agent/discovery] claude index parse failed path=%s err=%v", path, err)
		return nil
	}
	var paths []string
	if strings.TrimSpace(index.OriginalPath) != "" {
		paths = append(paths, index.OriginalPath)
	}
	for _, entry := range index.Entries {
		if strings.TrimSpace(entry.ProjectPath) != "" {
			paths = append(paths, entry.ProjectPath)
		}
	}
	return paths
}

func readClaudeProjectJSONLCwds(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var paths []string
	for _, entry := range entries {
		if entry == nil || entry.IsDir() || filepath.Ext(entry.Name()) != ".jsonl" {
			continue
		}
		if cwd := readClaudeSessionCwd(filepath.Join(dir, entry.Name())); cwd != "" {
			paths = append(paths, cwd)
		}
	}
	return paths
}

func readClaudeSessionCwd(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024), 1024*1024)
	for scanner.Scan() {
		var raw map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &raw); err != nil {
			continue
		}
		if cwd := strings.TrimSpace(asString(raw["cwd"])); cwd != "" {
			return cwd
		}
	}
	return ""
}

func asString(value any) string {
	text, _ := value.(string)
	return text
}
