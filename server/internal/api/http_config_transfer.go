package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/agent"
	configpkg "mindfs/server/internal/config"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/kanban"
	"mindfs/server/internal/preferences"
	"mindfs/server/internal/relay"
)

const transferFormat = "mindfs-user-config"
const transferMaxBytes = 32 << 20

var configTransferMu sync.Mutex

var transferPreferenceFields = map[string][]string{
	"agent_preferences": {"agent_pinned_models", "agents", "last_agent"},
	"behavior":          {"session_naming", "idle_session_resource_release_hours", "new_project_meta_location"},
	"nodes":             {"launcher_nodes"},
}

var transferServerCategories = map[string]bool{
	"agent_preferences": true, "behavior": true, "nodes": true,
	"prompts": true, "templates": true, "providers": true, "api_keys": true,
	"agent_backups": true, "custom_agents": true, "projects": true,
	"relay_services": true, "token_station": true,
}

type configArchive struct {
	Format    string                     `json:"format"`
	Version   int                        `json:"version"`
	CreatedAt string                     `json:"created_at"`
	Platform  string                     `json:"platform"`
	Sections  map[string]json.RawMessage `json:"sections"`
	Browser   json.RawMessage            `json:"browser,omitempty"`
}

type transferBackups struct {
	Manifest []agentConfigManifestEntry `json:"manifest"`
	Env      map[string][]string        `json:"env"`
	Files    map[string][]byte          `json:"files"`
}

type transferTemplates struct {
	Stages []kanban.StageTemplate `json:"stages"`
	Tasks  []kanban.TaskTemplate  `json:"tasks"`
}

type transferProjects struct {
	Dirs  []fs.RootInfo `json:"dirs"`
	Order []string      `json:"order"`
}

func decodeTransfer(value []byte, out any) error {
	if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return errors.New("null configuration is not allowed")
	}
	d := json.NewDecoder(bytes.NewReader(value))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("invalid trailing configuration data")
	}
	return nil
}

func transferJSON(value any) json.RawMessage { b, _ := json.Marshal(value); return b }

func readTransferJSON(path string, out any) error {
	b, err := readTransferBytes(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

func readTransferBytes(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > transferMaxBytes {
		return nil, errors.New("configuration file is not a regular file or exceeds 32 MB")
	}
	b, err := io.ReadAll(io.LimitReader(f, transferMaxBytes+1))
	if len(b) > transferMaxBytes {
		return nil, errors.New("configuration file exceeds 32 MB")
	}
	return b, err
}

func (h *HTTPHandler) handleConfigExport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var req struct {
		Categories []string `json:"categories"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid export request"))
		return
	}
	configTransferMu.Lock()
	defer configTransferMu.Unlock()
	archive, err := h.exportConfig(req.Categories)
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest(err.Error()))
		return
	}
	if len(transferJSON(archive)) > transferMaxBytes-(64<<10) {
		respondError(w, http.StatusBadRequest, errInvalidRequest("configuration archive exceeds 32 MB"))
		return
	}
	respondJSON(w, http.StatusOK, archive)
}

func (h *HTTPHandler) exportConfig(categories []string) (configArchive, error) {
	a := configArchive{Format: transferFormat, Version: 1, CreatedAt: time.Now().UTC().Format(time.RFC3339), Platform: runtime.GOOS, Sections: map[string]json.RawMessage{}}
	if h.AppContext == nil || h.AppContext.Prefs == nil {
		return a, errors.New("preferences not configured")
	}
	dir, err := configpkg.MindFSConfigDir()
	if err != nil {
		return a, err
	}
	prefs := h.AppContext.Prefs.Snapshot()
	// Config selections refer to device-specific active Agent configurations.
	// Importing preferences must never activate a backup or provider implicitly.
	for name, defaults := range prefs.Agents {
		defaults.LastConfigSelection = nil
		prefs.Agents[name] = defaults
	}
	var prefFields map[string]json.RawMessage
	_ = json.Unmarshal(transferJSON(prefs), &prefFields)
	defaults := map[string]json.RawMessage{
		"agent_pinned_models": transferJSON(map[string][]string{}), "agents": transferJSON(map[string]preferences.AgentDefaults{}),
		"last_agent": transferJSON(""), "session_naming": transferJSON(prefs.SessionNaming),
		"idle_session_resource_release_hours": transferJSON(h.AppContext.Prefs.IdleSessionResourceReleaseHours()),
		"new_project_meta_location":           transferJSON(h.AppContext.Prefs.NewProjectMetaLocation()), "launcher_nodes": transferJSON(h.AppContext.Prefs.LauncherNodes()),
	}
	totalBytes := 0
	for _, category := range categories {
		if !transferServerCategories[category] {
			return a, fmt.Errorf("unknown configuration category: %s", category)
		}
		if fields, ok := transferPreferenceFields[category]; ok {
			section := map[string]json.RawMessage{}
			for _, key := range fields {
				section[key] = defaults[key]
				if value, ok := prefFields[key]; ok {
					section[key] = value
				}
			}
			a.Sections[category] = transferJSON(section)
			totalBytes += len(a.Sections[category])
			if totalBytes > transferMaxBytes-(64<<10) {
				return a, errors.New("configuration archive exceeds 32 MB")
			}
			continue
		}
		switch category {
		case "prompts":
			items := []string{}
			if err = readTransferJSON(filepath.Join(dir, "prompts.json"), &items); err != nil {
				return a, err
			}
			a.Sections[category] = transferJSON(items)
		case "templates":
			if h.AppContext.Kanban == nil || h.AppContext.Kanban.Templates == nil {
				return a, errors.New("templates not configured")
			}
			t := transferTemplates{}
			if t.Stages, err = h.AppContext.Kanban.Templates.ListStageTemplates(); err != nil {
				return a, err
			}
			if t.Tasks, err = h.AppContext.Kanban.Templates.ListTaskTemplates(); err != nil {
				return a, err
			}
			a.Sections[category] = transferJSON(t)
		case "providers", "api_keys":
			providers, e := readAgentAPIProviders()
			if e != nil {
				return a, e
			}
			if category == "api_keys" {
				keys := map[string]string{}
				for _, p := range providers {
					if p.APIKey != "" {
						keys[p.ID] = p.APIKey
					}
				}
				a.Sections[category] = transferJSON(keys)
			} else {
				for i := range providers {
					providers[i].APIKey = ""
				}
				a.Sections[category] = transferJSON(providers)
			}
		case "agent_backups":
			backup := transferBackups{Files: map[string][]byte{}}
			backupBytes := 0
			if backup.Manifest, err = readAgentConfigManifest(); err != nil {
				return a, err
			}
			if backup.Env, err = readAgentEnvBackups(); err != nil {
				return a, err
			}
			for i := range backup.Manifest {
				entry := &backup.Manifest[i]
				for j := range entry.Sources {
					source := &entry.Sources[j]
					// Home-relative destinations follow the new user's home directory.
					if home, e := os.UserHomeDir(); e == nil {
						if rel, e := filepath.Rel(home, source.SourcePath); e == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
							source.SourcePath = "~/" + filepath.ToSlash(rel)
						}
					}
					if !validTransferBackupPath(entry.ID, source.BackupPath) {
						return a, errors.New("invalid backup path")
					}
					path := filepath.Join(dir, "agents-config", filepath.FromSlash(source.BackupPath))
					if err = checkTransferPath(dir, path); err != nil {
						return a, err
					}
					if backup.Files[source.BackupPath], err = readTransferBytes(path); err != nil {
						return a, err
					}
					backupBytes += len(backup.Files[source.BackupPath])
					if backupBytes > (transferMaxBytes*3/4)-(64<<10) {
						return a, errors.New("Agent configuration backups exceed archive size limit")
					}
				}
			}
			a.Sections[category] = transferJSON(backup)
		case "custom_agents":
			path, e := agent.ResolveConfigPath()
			if e != nil {
				return a, e
			}
			b, e := readTransferBytes(path)
			if os.IsNotExist(e) {
				continue
			}
			if e != nil {
				return a, e
			}
			if _, e = agent.DecodeConfig(b); e != nil {
				return a, e
			}
			a.Sections[category] = b
		case "projects":
			projects := transferProjects{Dirs: []fs.RootInfo{}, Order: []string{}}
			if err = readTransferJSON(filepath.Join(dir, "registry.json"), &projects); err != nil {
				return a, err
			}
			a.Sections[category] = transferJSON(projects)
		case "relay_services":
			var payload struct {
				Services []relay.LocalService `json:"services"`
			}
			payload.Services = []relay.LocalService{}
			if err = readTransferJSON(filepath.Join(dir, "relay-services.json"), &payload); err != nil {
				return a, err
			}
			a.Sections[category] = transferJSON(payload.Services)
		case "token_station":
			var credentials relay.Credentials
			if err = readTransferJSON(filepath.Join(dir, "credentials.json"), &credentials); err != nil {
				return a, err
			}
			a.Sections[category] = transferJSON(credentials.TokenStation)
		}
		totalBytes += len(a.Sections[category])
		if totalBytes > transferMaxBytes-(64<<10) {
			return a, errors.New("configuration archive exceeds 32 MB")
		}
	}
	return a, nil
}

func (h *HTTPHandler) handleConfigImport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var req struct {
		Archive    configArchive `json:"archive"`
		Categories []string      `json:"categories"`
	}
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, transferMaxBytes))
	if err != nil || decodeTransfer(b, &req) != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid configuration archive (maximum 32 MB)"))
		return
	}
	configTransferMu.Lock()
	defer configTransferMu.Unlock()
	restart, err := h.importConfig(req.Archive, req.Categories)
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest(err.Error()))
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"restart_required": restart})
}

func (h *HTTPHandler) importConfig(a configArchive, categories []string) (bool, error) {
	if a.Format != transferFormat || a.Version != 1 {
		return false, errors.New("unsupported configuration archive format or version")
	}
	if h.AppContext == nil || h.AppContext.Prefs == nil {
		return false, errors.New("preferences not configured")
	}
	dir, err := configpkg.MindFSConfigDir()
	if err != nil {
		return false, err
	}
	files := map[string][]byte{}
	fields := map[string]json.RawMessage{}
	restart := false
	selected := map[string]bool{}
	for _, category := range categories {
		if !transferServerCategories[category] || selected[category] {
			return false, errors.New("unknown or duplicate import category")
		}
		selected[category] = true
		if _, ok := a.Sections[category]; !ok {
			return false, fmt.Errorf("missing configuration category: %s", category)
		}
	}
	put := func(name string, value any) { files[filepath.Join(dir, name)] = transferJSON(value) }
	for _, category := range categories {
		value := a.Sections[category]
		if keys, ok := transferPreferenceFields[category]; ok {
			var section map[string]json.RawMessage
			if err := decodeTransfer(value, &section); err != nil {
				return false, err
			}
			if len(section) != len(keys) {
				return false, errors.New("incomplete preference category")
			}
			for _, key := range keys {
				v, ok := section[key]
				if !ok {
					return false, errors.New("missing preference: " + key)
				}
				fields[key] = v
			}
			continue
		}
		switch category {
		case "providers", "api_keys": // Process both together below, independent of selection order.
		case "prompts":
			var items []string
			if err := decodeTransfer(value, &items); err != nil {
				return false, err
			}
			if len(items) > 50 {
				return false, errors.New("too many saved prompts")
			}
			put("prompts.json", items)
		case "templates":
			var t transferTemplates
			if err := decodeTransfer(value, &t); err != nil {
				return false, err
			}
			// Validate with the existing store before changing any live file.
			tmp, err := os.MkdirTemp("", "mindfs-template-check-")
			if err != nil {
				return false, err
			}
			defer os.RemoveAll(tmp)
			store := kanban.NewTemplateStoreAt(tmp)
			seen := map[string]bool{}
			for _, stage := range t.Stages {
				if stage.ID == "" || seen[stage.ID] {
					return false, errors.New("invalid or duplicate stage template ID")
				}
				seen[stage.ID] = true
				if _, err := store.SaveStageTemplate(stage); err != nil {
					return false, err
				}
			}
			seen = map[string]bool{}
			for _, task := range t.Tasks {
				if task.ID == "" || seen[task.ID] {
					return false, errors.New("invalid or duplicate task template ID")
				}
				seen[task.ID] = true
				if _, err := store.SaveTaskTemplate(task); err != nil {
					return false, err
				}
			}
			put("stage_template.json", t.Stages)
			put("task_template.json", t.Tasks)
		case "agent_backups":
			var backup transferBackups
			if err := decodeTransfer(value, &backup); err != nil {
				return false, err
			}
			used, ids := map[string]bool{}, map[string]bool{}
			for _, entry := range backup.Manifest {
				if !validTransferSegment(entry.ID) || ids[entry.ID] || entry.Agent == "" || entry.Name == "" {
					return false, errors.New("invalid backup manifest")
				}
				ids[entry.ID] = true
				for _, source := range entry.Sources {
					content, exists := backup.Files[source.BackupPath]
					if !validTransferBackupPath(entry.ID, source.BackupPath) || !exists || used[source.BackupPath] {
						return false, errors.New("invalid or missing backup file")
					}
					used[source.BackupPath] = true
					files[filepath.Join(dir, "agents-config", filepath.FromSlash(source.BackupPath))] = content
				}
			}
			if len(used) != len(backup.Files) {
				return false, errors.New("unreferenced backup files")
			}
			for id, lines := range backup.Env {
				if !ids[id] {
					return false, errors.New("unreferenced backup environment")
				}
				if _, _, err := normalizeEnvLines(lines); err != nil {
					return false, err
				}
			}
			put("agents-config/manifest.json", backup.Manifest)
			put("agents-env.json", backup.Env)
		case "custom_agents":
			if _, err := agent.DecodeConfig(value); err != nil {
				return false, err
			}
			path, err := agent.ResolveConfigPath()
			if err != nil {
				return false, err
			}
			// This destination is resolved locally, never supplied by the archive.
			if err := checkTransferPath(filepath.Dir(path), path); err != nil {
				return false, err
			}
			files[path] = value
			restart = true
		case "projects":
			var projects transferProjects
			if err := decodeTransfer(value, &projects); err != nil {
				return false, err
			}
			ids, names, paths := map[string]bool{}, map[string]bool{}, map[string]bool{}
			for _, project := range projects.Dirs {
				if !validTransferSegment(project.ID) || project.Name == "" || ids[project.ID] || names[project.Name] || paths[project.RootPath] || !filepath.IsAbs(project.RootPath) {
					return false, errors.New("invalid or duplicate project")
				}
				if project.MetaLocation != "" && project.MetaLocation != "home" && project.MetaLocation != "project" {
					return false, errors.New("invalid project metadata location")
				}
				info, err := os.Stat(project.RootPath)
				if err != nil || !info.IsDir() {
					return false, fmt.Errorf("project directory does not exist: %s", project.RootPath)
				}
				ids[project.ID], names[project.Name], paths[project.RootPath] = true, true, true
			}
			seen := map[string]bool{}
			for _, id := range projects.Order {
				if !ids[id] || seen[id] {
					return false, errors.New("invalid project order")
				}
				seen[id] = true
			}
			put("registry.json", projects)
			restart = true
		case "relay_services":
			var services []relay.LocalService
			if err := decodeTransfer(value, &services); err != nil {
				return false, err
			}
			seen := map[string]bool{}
			for i, service := range services {
				normalized, err := relay.NormalizeLocalService(service)
				if err != nil {
					return false, err
				}
				if seen[normalized.Slug] {
					return false, errors.New("duplicate relay service")
				}
				seen[normalized.Slug] = true
				normalized.Enabled = false
				services[i] = normalized
			}
			put("relay-services.json", struct {
				Services []relay.LocalService `json:"services"`
			}{services})
		case "token_station":
			var token relay.TokenStationCredentials
			if err := decodeTransfer(value, &token); err != nil {
				return false, err
			}
			var current relay.Credentials
			if err := readTransferJSON(filepath.Join(dir, "credentials.json"), &current); err != nil {
				return false, err
			}
			current.TokenStation = token
			put("credentials.json", current)
		}
	}
	if selected["providers"] || selected["api_keys"] {
		current, err := readAgentAPIProviders()
		if err != nil {
			return false, err
		}
		next := current
		if selected["providers"] {
			next = nil // Decode into fresh structs; omitted keys must not retain old slice fields.
			if err := decodeTransfer(a.Sections["providers"], &next); err != nil {
				return false, err
			}
			seen := map[string]bool{}
			for i := range next {
				p := &next[i]
				if p.ID == "" || p.Name == "" || seen[p.ID] || p.APIKey != "" {
					return false, errors.New("invalid provider (keys must be in api_keys)")
				}
				seen[p.ID] = true
				if _, err := normalizeAPIProviderBaseURL(p.BaseURL); err != nil {
					return false, err
				}
				for _, old := range current {
					if old.ID == p.ID && old.BaseURL == p.BaseURL {
						p.APIKey = old.APIKey
					}
				}
			}
		}
		if selected["api_keys"] {
			var keys map[string]string
			if err := decodeTransfer(a.Sections["api_keys"], &keys); err != nil {
				return false, err
			}
			for id, key := range keys {
				found := false
				for i := range next {
					if next[i].ID == id {
						next[i].APIKey = key
						found = true
						break
					}
				}
				if !found {
					return false, errors.New("API key has no matching provider; also select API providers")
				}
			}
		}
		put("api-providers.json", next)
	}
	if err := preferences.ValidateTransfer(fields); err != nil {
		return false, err
	}
	// Active configuration associations are device state, never imported through agent defaults.
	if raw, ok := fields["agents"]; ok {
		var agents map[string]preferences.AgentDefaults
		_ = json.Unmarshal(raw, &agents)
		current := h.AppContext.Prefs.Snapshot()
		for name, defaults := range agents {
			defaults.LastConfigSelection = current.Agents[name].LastConfigSelection
			agents[name] = defaults
		}
		fields["agents"] = transferJSON(agents)
	}
	rollback, err := writeTransferFiles(dir, files)
	if err != nil {
		return false, err
	}
	if len(fields) > 0 {
		if err := h.AppContext.Prefs.ImportFields(fields); err != nil {
			return false, errors.Join(err, rollback())
		}
	}
	return restart, nil
}

func validTransferSegment(s string) bool {
	return s != "" && s != "." && s != ".." && !strings.ContainsAny(s, "/\\:\x00")
}

func validTransferBackupPath(id, path string) bool {
	parts := strings.Split(path, "/")
	return validTransferSegment(id) && len(parts) == 2 && parts[0] == id && validTransferSegment(parts[1])
}

// Reject symlinks under the destination root, including existing parent directories.
func checkTransferPath(root, path string) error {
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return errors.New("invalid configuration destination")
	}
	current := root
	for _, part := range append([]string{""}, strings.Split(rel, string(filepath.Separator))...) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("configuration destination must not be a symlink")
		}
	}
	return nil
}

func atomicTransferWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".mindfs-import-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Chmod(mode); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// Validate and save all old contents before the first mutation. A write failure
// restores completed writes; preference validation also happens before this call.
func writeTransferFiles(root string, files map[string][]byte) (func() error, error) {
	type previous struct {
		data   []byte
		exists bool
		mode   os.FileMode
	}
	old := map[string]previous{}
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		base := root
		if rel, _ := filepath.Rel(root, path); rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			base = filepath.Dir(path)
		}
		if err := checkTransferPath(base, path); err != nil {
			return nil, err
		}
		b, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		p := previous{data: b, exists: err == nil, mode: 0o600}
		if p.exists {
			info, err := os.Stat(path)
			if err != nil {
				return nil, err
			}
			p.mode = info.Mode().Perm()
		}
		old[path] = p
	}
	written := []string{}
	rollback := func() error {
		var result error
		for i := len(written) - 1; i >= 0; i-- {
			path := written[i]
			p := old[path]
			var err error
			if p.exists {
				err = atomicTransferWrite(path, p.data, p.mode)
			} else {
				err = os.Remove(path)
			}
			result = errors.Join(result, err)
		}
		return result
	}
	for _, path := range paths {
		if err := atomicTransferWrite(path, files[path], 0o600); err != nil {
			return nil, errors.Join(err, rollback())
		}
		written = append(written, path)
	}
	return rollback, nil
}
