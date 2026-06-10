package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"mindfs/server/internal/agent"
	configpkg "mindfs/server/internal/config"
)

type agentConfigSource struct {
	SourcePath string `json:"sourcePath"`
	BackupPath string `json:"backupPath"`
}

type agentConfigManifestEntry struct {
	ID        string              `json:"id"`
	Agent     string              `json:"agent"`
	Name      string              `json:"name"`
	CreatedAt string              `json:"createdAt"`
	UpdatedAt string              `json:"updatedAt"`
	Sources   []agentConfigSource `json:"sources,omitempty"`
	EnvKeys   []string            `json:"envKeys,omitempty"`
}

type agentConfigBackupRequest struct {
	Agent       string   `json:"agent"`
	Name        string   `json:"name"`
	FileSources []string `json:"file_sources"`
	EnvLines    []string `json:"env_lines"`
	Overwrite   bool     `json:"overwrite"`
}

type agentConfigSwitchRequest struct {
	ID               string `json:"id"`
	ConfirmOverwrite bool   `json:"confirm_overwrite"`
}

type agentRestartRequest struct {
	Agent string `json:"agent"`
}

var agentConfigNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func (h *HTTPHandler) handleAgentConfigDefaults(w http.ResponseWriter, r *http.Request) {
	agentName := strings.TrimSpace(r.URL.Query().Get("agent"))
	if agentName == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("agent required"))
		return
	}
	cfg, err := agent.LoadConfig("")
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	def, ok := cfg.GetAgent(agentName)
	if !ok {
		respondError(w, http.StatusNotFound, errInvalidRequest("agent not configured"))
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"agent":        def.Name,
		"file_sources": existingDefaultFileSources(def.ConfigBackup.FileSources),
		"env_keys":     def.ConfigBackup.EnvKeys,
	})
}

func (h *HTTPHandler) handleAgentConfigBackupsList(w http.ResponseWriter, r *http.Request) {
	agentName := strings.TrimSpace(r.URL.Query().Get("agent"))
	manifest, err := readAgentConfigManifest()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	if agentName == "" {
		respondJSON(w, http.StatusOK, manifest)
		return
	}
	filtered := make([]agentConfigManifestEntry, 0, len(manifest))
	for _, item := range manifest {
		if item.Agent == agentName {
			filtered = append(filtered, item)
		}
	}
	respondJSON(w, http.StatusOK, filtered)
}

func (h *HTTPHandler) handleAgentConfigBackupCreate(w http.ResponseWriter, r *http.Request) {
	var req agentConfigBackupRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxUploadRequestBytes)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid request body"))
		return
	}
	entry, err := createAgentConfigBackup(req)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errAgentConfigConflict) {
			status = http.StatusConflict
		}
		respondError(w, status, errInvalidRequest(err.Error()))
		return
	}
	respondJSON(w, http.StatusOK, entry)
}

func (h *HTTPHandler) handleAgentConfigBackupDelete(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("backup id required"))
		return
	}
	manifest, err := deleteAgentConfigBackup(id)
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest(err.Error()))
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"deleted": true, "id": id, "backups": manifest})
}

func (h *HTTPHandler) handleAgentConfigSwitch(w http.ResponseWriter, r *http.Request) {
	var req agentConfigSwitchRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxUploadRequestBytes)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid request body"))
		return
	}
	entry, needsConfirm, err := switchAgentConfig(req, h.AppContext)
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest(err.Error()))
		return
	}
	if needsConfirm {
		respondJSON(w, http.StatusOK, map[string]any{
			"needs_confirm": true,
			"message":       "目标配置文件已存在，请确保已备份",
			"backup":        entry,
		})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"needs_confirm": false,
		"backup":        entry,
	})
}

func (h *HTTPHandler) handleAgentRestart(w http.ResponseWriter, r *http.Request) {
	var req agentRestartRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxUploadRequestBytes)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid request body"))
		return
	}
	if err := restartAgent(req.Agent, h.AppContext); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest(err.Error()))
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"restarting": true,
		"agent":      strings.TrimSpace(req.Agent),
	})
}

var errAgentConfigConflict = errors.New("backup already exists")

func createAgentConfigBackup(req agentConfigBackupRequest) (agentConfigManifestEntry, error) {
	agentName, backupName, id, err := normalizeAgentConfigRequest(req.Agent, req.Name)
	if err != nil {
		return agentConfigManifestEntry{}, err
	}
	cfg, err := agent.LoadConfig("")
	if err != nil {
		return agentConfigManifestEntry{}, err
	}
	if _, ok := cfg.GetAgent(agentName); !ok {
		return agentConfigManifestEntry{}, fmt.Errorf("agent not configured: %s", agentName)
	}
	configRoot, err := agentConfigRootDir()
	if err != nil {
		return agentConfigManifestEntry{}, err
	}
	manifest, err := readAgentConfigManifest()
	if err != nil {
		return agentConfigManifestEntry{}, err
	}
	existingIndex := -1
	var createdAt string
	for index, item := range manifest {
		if item.ID == id {
			if !req.Overwrite {
				return agentConfigManifestEntry{}, errAgentConfigConflict
			}
			existingIndex = index
			createdAt = item.CreatedAt
			break
		}
	}
	now := time.Now().Format(time.RFC3339)
	if createdAt == "" {
		createdAt = now
	}
	entry := agentConfigManifestEntry{
		ID:        id,
		Agent:     agentName,
		Name:      backupName,
		CreatedAt: createdAt,
		UpdatedAt: now,
	}
	sources, err := normalizeFileSources(req.FileSources)
	if err != nil {
		return agentConfigManifestEntry{}, err
	}
	envLines, envKeys, err := normalizeEnvLines(req.EnvLines)
	if err != nil {
		return agentConfigManifestEntry{}, err
	}
	if len(sources) == 0 && len(envLines) == 0 {
		return agentConfigManifestEntry{}, errors.New("config source or environment variables required")
	}
	if err := os.RemoveAll(filepath.Join(configRoot, id)); err != nil {
		return agentConfigManifestEntry{}, err
	}
	for index, source := range sources {
		name := fmt.Sprintf("%03d-%s", index+1, filepath.Base(source))
		rel := filepath.Join(id, name)
		dst := filepath.Join(configRoot, rel)
		if err := copyFile(source, dst); err != nil {
			return agentConfigManifestEntry{}, err
		}
		entry.Sources = append(entry.Sources, agentConfigSource{
			SourcePath: source,
			BackupPath: filepath.ToSlash(rel),
		})
	}
	envMap, err := readAgentEnvBackups()
	if err != nil {
		return agentConfigManifestEntry{}, err
	}
	if len(envLines) > 0 {
		envMap[id] = envLines
		entry.EnvKeys = envKeys
	} else {
		delete(envMap, id)
	}
	if err := writeAgentEnvBackups(envMap); err != nil {
		return agentConfigManifestEntry{}, err
	}
	if err := updateAgentConfigDefaults(agentName, sources, envKeys); err != nil {
		return agentConfigManifestEntry{}, err
	}
	if existingIndex >= 0 {
		manifest[existingIndex] = entry
	} else {
		manifest = append(manifest, entry)
	}
	if err := writeAgentConfigManifest(manifest); err != nil {
		return agentConfigManifestEntry{}, err
	}
	return entry, nil
}

func deleteAgentConfigBackup(id string) ([]agentConfigManifestEntry, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, errors.New("backup id required")
	}
	manifest, err := readAgentConfigManifest()
	if err != nil {
		return nil, err
	}
	next := make([]agentConfigManifestEntry, 0, len(manifest))
	found := false
	for _, item := range manifest {
		if item.ID == id {
			found = true
			continue
		}
		next = append(next, item)
	}
	if !found {
		return nil, errors.New("backup not found")
	}
	if err := writeAgentConfigManifest(next); err != nil {
		return nil, err
	}
	configRoot, err := agentConfigRootDir()
	if err != nil {
		return nil, err
	}
	if err := os.RemoveAll(filepath.Join(configRoot, id)); err != nil {
		return nil, err
	}
	envBackups, err := readAgentEnvBackups()
	if err != nil {
		return nil, err
	}
	if _, ok := envBackups[id]; ok {
		delete(envBackups, id)
		if err := writeAgentEnvBackups(envBackups); err != nil {
			return nil, err
		}
	}
	return next, nil
}

func switchAgentConfig(req agentConfigSwitchRequest, app *AppContext) (agentConfigManifestEntry, bool, error) {
	id := strings.TrimSpace(req.ID)
	if id == "" {
		return agentConfigManifestEntry{}, false, errors.New("backup id required")
	}
	manifest, err := readAgentConfigManifest()
	if err != nil {
		return agentConfigManifestEntry{}, false, err
	}
	var entry agentConfigManifestEntry
	for _, item := range manifest {
		if item.ID == id {
			entry = item
			break
		}
	}
	if entry.ID == "" {
		return agentConfigManifestEntry{}, false, errors.New("backup not found")
	}
	if len(entry.Sources) == 0 && len(entry.EnvKeys) == 0 {
		return agentConfigManifestEntry{}, false, errors.New("backup has no config content")
	}
	exists := false
	for _, source := range entry.Sources {
		sourcePath, err := expandUserPath(source.SourcePath)
		if err != nil {
			return agentConfigManifestEntry{}, false, err
		}
		if _, err := os.Stat(sourcePath); err == nil {
			exists = true
			break
		} else if err != nil && !os.IsNotExist(err) {
			return agentConfigManifestEntry{}, false, err
		}
	}
	if exists && !req.ConfirmOverwrite {
		return entry, true, nil
	}
	configRoot, err := agentConfigRootDir()
	if err != nil {
		return agentConfigManifestEntry{}, false, err
	}
	for _, source := range entry.Sources {
		sourcePath, err := expandUserPath(source.SourcePath)
		if err != nil {
			return agentConfigManifestEntry{}, false, err
		}
		if err := copyFile(filepath.Join(configRoot, filepath.FromSlash(source.BackupPath)), sourcePath); err != nil {
			return agentConfigManifestEntry{}, false, err
		}
	}
	var env map[string]string
	if len(entry.EnvKeys) > 0 {
		envBackups, err := readAgentEnvBackups()
		if err != nil {
			return agentConfigManifestEntry{}, false, err
		}
		lines, ok := envBackups[entry.ID]
		if !ok {
			return agentConfigManifestEntry{}, false, errors.New("environment backup not found")
		}
		parsedEnv, _, err := envLinesToMap(lines)
		if err != nil {
			return agentConfigManifestEntry{}, false, err
		}
		env = parsedEnv
		if err := updateAgentEnvConfig(entry.Agent, env); err != nil {
			return agentConfigManifestEntry{}, false, err
		}
		if app != nil && app.GetAgentPool() != nil {
			if err := app.GetAgentPool().SetAgentEnv(entry.Agent, env); err != nil {
				return agentConfigManifestEntry{}, false, err
			}
		}
		if app != nil && app.GetProber() != nil {
			if err := app.GetProber().SetAgentEnv(entry.Agent, env); err != nil {
				return agentConfigManifestEntry{}, false, err
			}
		}
	}
	if app != nil && app.GetAgentPool() != nil {
		app.GetAgentPool().KillAgentProcess(entry.Agent, 0)
	}
	triggerAgentConfigSwitchProbe(app, entry.Agent)
	return entry, false, nil
}

func restartAgent(agentName string, app *AppContext) error {
	agentName = strings.TrimSpace(agentName)
	if agentName == "" {
		return errors.New("agent required")
	}
	if app == nil || app.GetAgentPool() == nil {
		return errors.New("agent pool not configured")
	}
	if _, ok := app.GetAgentPool().Config().GetAgent(agentName); !ok {
		return fmt.Errorf("agent not configured: %s", agentName)
	}
	app.GetAgentPool().KillAgentProcess(agentName, 0)
	triggerAgentConfigSwitchProbe(app, agentName)
	return nil
}

func triggerAgentConfigSwitchProbe(app *AppContext, agentName string) {
	if app == nil || app.GetProber() == nil {
		return
	}
	prober := app.GetProber()
	if err := prober.ClearProbeSession(agentName); err != nil {
		log.Printf("[agent-config] clear_probe_session.error agent=%s err=%v", agentName, err)
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
		defer cancel()
		status := prober.ProbeOne(ctx, agentName)
		if status.Error != "" {
			log.Printf("[agent-config] switch_probe.completed agent=%s available=%t err=%q", agentName, status.Available, status.Error)
			return
		}
		log.Printf("[agent-config] switch_probe.completed agent=%s available=%t", agentName, status.Available)
	}()
}

func normalizeAgentConfigRequest(agentName, backupName string) (string, string, string, error) {
	agentName = strings.TrimSpace(agentName)
	backupName = strings.TrimSpace(backupName)
	if agentName == "" {
		return "", "", "", errors.New("agent required")
	}
	if backupName == "" {
		return "", "", "", errors.New("backup name required")
	}
	if !agentConfigNamePattern.MatchString(backupName) || strings.Contains(backupName, "..") {
		return "", "", "", errors.New("backup name may only contain letters, numbers, dot, underscore, and hyphen")
	}
	return agentName, backupName, agentName + "-" + backupName, nil
}

func normalizeFileSources(input []string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for _, item := range input {
		path := strings.TrimSpace(item)
		if path == "" {
			continue
		}
		path, err := expandUserPath(path)
		if err != nil {
			return nil, err
		}
		if seen[path] {
			continue
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, fmt.Errorf("config source not found: %s", path)
		}
		if info.IsDir() {
			return nil, fmt.Errorf("config source is a directory: %s", path)
		}
		seen[path] = true
		out = append(out, path)
	}
	return out, nil
}

func existingDefaultFileSources(input []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, item := range input {
		path := strings.TrimSpace(item)
		if path == "" {
			continue
		}
		path, err := expandUserPath(path)
		if err != nil || path == "" || seen[path] {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		seen[path] = true
		out = append(out, path)
	}
	return out
}

func normalizeEnvLines(input []string) ([]string, []string, error) {
	var lines []string
	var keys []string
	seen := map[string]bool{}
	for _, raw := range input {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		rawKey, rawValue, ok := strings.Cut(line, "=")
		key := strings.TrimSpace(rawKey)
		if !ok || key == "" {
			return nil, nil, fmt.Errorf("invalid env line: %s", line)
		}
		value := strings.TrimSpace(rawValue)
		if value == "" {
			continue
		}
		lines = append(lines, key+"="+value)
		if !seen[key] {
			seen[key] = true
			keys = append(keys, key)
		}
	}
	return lines, keys, nil
}

func envLinesToMap(lines []string) (map[string]string, []string, error) {
	env := make(map[string]string, len(lines))
	var keys []string
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return nil, nil, fmt.Errorf("invalid env line: %s", line)
		}
		env[key] = value
		keys = append(keys, key)
	}
	return env, keys, nil
}

func expandUserPath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", nil
	}
	if path != "~" && !strings.HasPrefix(path, "~/") && !strings.HasPrefix(path, `~\`) {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if path == "~" {
		return home, nil
	}
	return filepath.Join(home, strings.TrimLeft(path[1:], `/\`)), nil
}

func updateAgentConfigDefaults(agentName string, fileSources []string, envKeys []string) error {
	path, err := agent.ResolveConfigPath()
	if err != nil {
		return err
	}
	cfg, err := agent.LoadConfig("")
	if err != nil {
		return err
	}
	found := false
	for i := range cfg.Agents {
		if cfg.Agents[i].Name != agentName {
			continue
		}
		found = true
		cfg.Agents[i].ConfigBackup.FileSources = append([]string(nil), fileSources...)
		cfg.Agents[i].ConfigBackup.EnvKeys = append([]string(nil), envKeys...)
		break
	}
	if !found {
		return fmt.Errorf("agent not configured: %s", agentName)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	return os.WriteFile(path, payload, 0o644)
}

func updateAgentEnvConfig(agentName string, env map[string]string) error {
	path, err := agent.ResolveConfigPath()
	if err != nil {
		return err
	}
	cfg, err := agent.LoadConfig("")
	if err != nil {
		return err
	}
	found := false
	for i := range cfg.Agents {
		if cfg.Agents[i].Name != agentName {
			continue
		}
		found = true
		cfg.Agents[i].Env = cloneStringMap(env)
		break
	}
	if !found {
		return fmt.Errorf("agent not configured: %s", agentName)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	return os.WriteFile(path, payload, 0o644)
}

func cloneStringMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	out := make(map[string]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func readAgentConfigManifest() ([]agentConfigManifestEntry, error) {
	path, err := agentConfigManifestPath()
	if err != nil {
		return nil, err
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []agentConfigManifestEntry{}, nil
		}
		return nil, err
	}
	var manifest []agentConfigManifestEntry
	if len(strings.TrimSpace(string(payload))) == 0 {
		return []agentConfigManifestEntry{}, nil
	}
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return nil, err
	}
	return manifest, nil
}

func writeAgentConfigManifest(manifest []agentConfigManifestEntry) error {
	path, err := agentConfigManifestPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	return os.WriteFile(path, payload, 0o644)
}

func readAgentEnvBackups() (map[string][]string, error) {
	path, err := agentEnvPath()
	if err != nil {
		return nil, err
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string][]string{}, nil
		}
		return nil, err
	}
	if len(strings.TrimSpace(string(payload))) == 0 {
		return map[string][]string{}, nil
	}
	var out map[string][]string
	if err := json.Unmarshal(payload, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string][]string{}
	}
	return out, nil
}

func writeAgentEnvBackups(env map[string][]string) error {
	path, err := agentEnvPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(env, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	return os.WriteFile(path, payload, 0o644)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

func agentConfigRootDir() (string, error) {
	configDir, err := configpkg.MindFSConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "agents-config"), nil
}

func agentConfigManifestPath() (string, error) {
	root, err := agentConfigRootDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "manifest.json"), nil
}

func agentEnvPath() (string, error) {
	configDir, err := configpkg.MindFSConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "agents-env.json"), nil
}
