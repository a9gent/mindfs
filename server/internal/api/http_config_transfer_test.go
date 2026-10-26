package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	configpkg "mindfs/server/internal/config"
	"mindfs/server/internal/e2ee"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/kanban"
	"mindfs/server/internal/preferences"
	"mindfs/server/internal/relay"
	"mindfs/server/internal/testutil"
)

func newConfigTransferTestHandler(t *testing.T) (*HTTPHandler, string) {
	t.Helper()
	testutil.IsolateUserDirs(t, t.TempDir())
	t.Setenv("MINDFS_AGENTS_CONFIG", "")
	dir, err := configpkg.MindFSConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	prefs, err := preferences.NewStore()
	if err != nil {
		t.Fatal(err)
	}
	return &HTTPHandler{AppContext: &AppContext{Prefs: prefs, Kanban: kanban.NewService(kanban.NewTemplateStoreAt(dir), nil)}}, dir
}

func TestConfigTransferRoundTripAcrossDevices(t *testing.T) {
	source, dir := newConfigTransferTestHandler(t)
	prefs := source.AppContext.Prefs
	if _, err := prefs.UpdateAgentDefaultsIfChanged("codex", "model-a", "high", "fast"); err != nil {
		t.Fatal(err)
	}
	if err := prefs.UpdateNewProjectMetaLocation("home"); err != nil {
		t.Fatal(err)
	}
	if err := prefs.UpdateIdleSessionResourceReleaseHours(12); err != nil {
		t.Fatal(err)
	}
	if err := prefs.UpdateLauncherNodes([]preferences.LauncherNode{{ID: "node-1", Name: "work", URL: "https://work.example", CreatedAt: "2026-10-26"}}); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(dir, "prompts.json"), []string{"review this change"})
	writeJSON(t, filepath.Join(dir, "stage_template.json"), []kanban.StageTemplate{{ID: "stage-a", Name: "Review", Role: "agent", Agent: "codex"}})
	writeJSON(t, filepath.Join(dir, "task_template.json"), []kanban.TaskTemplate{{ID: "task-a", Name: "Review", MaxConcurrency: 3, Stages: []kanban.TaskTemplateStage{{ID: "task-stage-a", Snapshot: kanban.StageTemplate{Role: "user", Name: "Input"}}}}})
	writeJSON(t, filepath.Join(dir, "api-providers.json"), []agentAPIProvider{{ID: "provider-a", Name: "API", BaseURL: "https://api.example/v1", APIKey: "private-api-key", Models: []string{"model-a"}}})
	writeJSON(t, filepath.Join(dir, "agents.json"), map[string]any{"agents": []any{map[string]any{"name": "custom", "command": "custom-agent", "protocol": "acp", "env": map[string]string{"CUSTOM_KEY": "private-env"}}}})
	writeJSON(t, filepath.Join(dir, "credentials.json"), relay.Credentials{Relay: relay.RelayCredentials{DeviceToken: "old-device-token", NodeID: "old-node"}, TokenStation: relay.TokenStationCredentials{Token: "station-secret"}})
	writeJSON(t, filepath.Join(dir, "relay-services.json"), map[string]any{"services": []relay.LocalService{{Slug: "web", Name: "Web", LocalURL: "http://127.0.0.1:3000", Enabled: true}}})
	oldProject := t.TempDir()
	writeJSON(t, filepath.Join(dir, "registry.json"), transferProjects{Dirs: []fs.RootInfo{{ID: "project-a", Name: "project", RootPath: oldProject}}, Order: []string{"project-a"}})
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(dir, "agents-config", "manifest.json"), []agentConfigManifestEntry{{ID: "backup-a", Agent: "codex", Name: "A", Sources: []agentConfigSource{{SourcePath: filepath.Join(home, ".codex", "config.toml"), BackupPath: "backup-a/config.toml"}}}})
	writeJSON(t, filepath.Join(dir, "agents-env.json"), map[string][]string{"backup-a": {"API_KEY=backup-env"}})
	backupPath := filepath.Join(dir, "agents-config", "backup-a", "config.toml")
	if err := os.MkdirAll(filepath.Dir(backupPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backupPath, []byte("api_key = 'backup-secret'"), 0o600); err != nil {
		t.Fatal(err)
	}

	ordinary := []string{"agent_preferences", "behavior", "nodes", "prompts", "templates", "providers"}
	plain, err := source.exportConfig(ordinary)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(transferJSON(plain))
	for _, secret := range []string{"private-api-key", "private-env", "station-secret", "old-device-token", "backup-secret", "backup-env"} {
		if strings.Contains(serialized, secret) {
			t.Fatalf("unselected secret leaked: %s", secret)
		}
	}
	all := append(ordinary, "api_keys", "agent_backups", "custom_agents", "projects", "relay_services", "token_station")
	archive, err := source.exportConfig(all)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(transferJSON(archive)), "old-device-token") {
		t.Fatal("device token must never be exported")
	}
	var backups transferBackups
	if err := json.Unmarshal(archive.Sections["agent_backups"], &backups); err != nil {
		t.Fatal(err)
	}
	if backups.Manifest[0].Sources[0].SourcePath != "~/.codex/config.toml" {
		t.Fatal("home paths should be portable")
	}

	destination, destinationDir := newConfigTransferTestHandler(t)
	writeJSON(t, filepath.Join(destinationDir, "credentials.json"), relay.Credentials{Relay: relay.RelayCredentials{DeviceToken: "new-device-token", NodeID: "new-node"}})
	newProject := t.TempDir()
	var projects transferProjects
	_ = json.Unmarshal(archive.Sections["projects"], &projects)
	projects.Dirs[0].RootPath = newProject
	archive.Sections["projects"] = transferJSON(projects)
	restart, err := destination.importConfig(archive, all)
	if err != nil {
		t.Fatal(err)
	}
	if !restart {
		t.Fatal("custom agents and registry require restart")
	}
	if destination.AppContext.Prefs.NewProjectMetaLocation() != "home" || destination.AppContext.Prefs.IdleSessionResourceReleaseHours() != 12 {
		t.Fatal("live preferences did not update")
	}
	if len(destination.AppContext.Prefs.LauncherNodes()) != 1 {
		t.Fatal("nodes not restored")
	}
	providers, err := readAgentAPIProviders()
	if err != nil || len(providers) != 1 || providers[0].APIKey != "private-api-key" {
		t.Fatalf("provider key round trip: %#v, %v", providers, err)
	}
	var credentials relay.Credentials
	if err := readTransferJSON(filepath.Join(destinationDir, "credentials.json"), &credentials); err != nil {
		t.Fatal(err)
	}
	if credentials.Relay.DeviceToken != "new-device-token" || credentials.TokenStation.Token != "station-secret" {
		t.Fatal("credentials were not isolated")
	}
	var mappings struct {
		Services []relay.LocalService `json:"services"`
	}
	if err := readTransferJSON(filepath.Join(destinationDir, "relay-services.json"), &mappings); err != nil || len(mappings.Services) != 1 || mappings.Services[0].Enabled {
		t.Fatal("imported mapping must be disabled")
	}
	content, err := os.ReadFile(filepath.Join(destinationDir, "agents-config", "backup-a", "config.toml"))
	if err != nil || string(content) != "api_key = 'backup-secret'" {
		t.Fatal("backup contents changed")
	}
	if _, err := os.Stat(filepath.Join(destinationDir, "device.json")); !os.IsNotExist(err) {
		t.Fatal("device identity should not be imported")
	}
	reopened, err := preferences.NewStore()
	if err != nil || reopened.IdleSessionResourceReleaseHours() != 12 {
		t.Fatal("preferences were not persisted")
	}
	stages, err := destination.AppContext.Kanban.Templates.ListStageTemplates()
	if err != nil || len(stages) != 1 {
		t.Fatal("live template store did not see imported templates")
	}
}

func TestConfigImportSelectionAndValidationBeforeWrites(t *testing.T) {
	h, dir := newConfigTransferTestHandler(t)
	if err := h.AppContext.Prefs.UpdateIdleSessionResourceReleaseHours(24); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(dir, "prompts.json"), []string{"original"})
	archive := configArchive{Format: transferFormat, Version: 1, Sections: map[string]json.RawMessage{
		"prompts":  transferJSON([]string{"imported"}),
		"behavior": transferJSON(map[string]any{"session_naming": map[string]any{}, "idle_session_resource_release_hours": -1, "new_project_meta_location": "home"}),
	}}
	if _, err := h.importConfig(archive, []string{"prompts", "behavior"}); err == nil {
		t.Fatal("invalid preferences accepted")
	}
	var items []string
	_ = readTransferJSON(filepath.Join(dir, "prompts.json"), &items)
	if len(items) != 1 || items[0] != "original" {
		t.Fatal("validation failure changed files")
	}
	if _, err := h.importConfig(archive, []string{"prompts"}); err != nil {
		t.Fatal(err)
	}
	if h.AppContext.Prefs.IdleSessionResourceReleaseHours() != 24 {
		t.Fatal("unselected category changed")
	}
	_ = readTransferJSON(filepath.Join(dir, "prompts.json"), &items)
	if items[0] != "imported" {
		t.Fatal("selected category not imported")
	}
	for _, categories := range [][]string{{"device"}, {"nodes"}, {"prompts", "prompts"}} {
		if _, err := h.importConfig(archive, categories); err == nil {
			t.Fatalf("invalid selection accepted: %v", categories)
		}
	}
	archive.Version = 999
	if _, err := h.importConfig(archive, []string{"prompts"}); err == nil {
		t.Fatal("unsupported version accepted")
	}
}

func TestConfigImportProviderKeysRequireExplicitSelection(t *testing.T) {
	h, dir := newConfigTransferTestHandler(t)
	writeJSON(t, filepath.Join(dir, "api-providers.json"), []agentAPIProvider{{ID: "provider-a", Name: "Old", BaseURL: "https://api.example", APIKey: "destination-key"}})
	a := configArchive{Format: transferFormat, Version: 1, Sections: map[string]json.RawMessage{
		"providers": transferJSON([]agentAPIProvider{{ID: "provider-a", Name: "New", BaseURL: "https://api.example"}}),
		"api_keys":  transferJSON(map[string]string{"provider-a": "source-key"}),
	}}
	if _, err := h.importConfig(a, []string{"providers"}); err != nil {
		t.Fatal(err)
	}
	providers, _ := readAgentAPIProviders()
	if providers[0].Name != "New" || providers[0].APIKey != "destination-key" {
		t.Fatal("provider-only import should retain matching destination key")
	}
	if _, err := h.importConfig(a, []string{"api_keys"}); err != nil {
		t.Fatal(err)
	}
	providers, _ = readAgentAPIProviders()
	if providers[0].APIKey != "source-key" {
		t.Fatal("explicit key import not applied")
	}
	// Embedded keys cannot bypass the separate sensitive category.
	a.Sections["providers"] = transferJSON([]agentAPIProvider{{ID: "provider-a", Name: "Bad", BaseURL: "https://api.example", APIKey: "embedded-key"}})
	if _, err := h.importConfig(a, []string{"providers"}); err == nil {
		t.Fatal("embedded provider key accepted")
	}
	providers, _ = readAgentAPIProviders()
	if providers[0].APIKey != "source-key" {
		t.Fatal("invalid import changed key")
	}
}

func TestConfigImportRejectsBackupTraversalAndSymlinks(t *testing.T) {
	h, dir := newConfigTransferTestHandler(t)
	for _, path := range []string{"../credentials.json", "backup-a/../../credentials.json", "backup-a\\key", "/tmp/key", "backup-a/../key"} {
		a := configArchive{Format: transferFormat, Version: 1, Sections: map[string]json.RawMessage{"agent_backups": transferJSON(transferBackups{
			Manifest: []agentConfigManifestEntry{{ID: "backup-a", Name: "A", Agent: "codex", Sources: []agentConfigSource{{BackupPath: path}}}}, Files: map[string][]byte{path: []byte("attack")},
		})}}
		if _, err := h.importConfig(a, []string{"agent_backups"}); err == nil {
			t.Fatalf("traversal accepted: %s", path)
		}
	}
	outside := filepath.Join(t.TempDir(), "prompts.json")
	if err := os.WriteFile(outside, []byte(`["outside"]`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "prompts.json")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	a := configArchive{Format: transferFormat, Version: 1, Sections: map[string]json.RawMessage{"prompts": transferJSON([]string{"attack"})}}
	if _, err := h.importConfig(a, []string{"prompts"}); err == nil {
		t.Fatal("symlink destination accepted")
	}
	content, _ := os.ReadFile(outside)
	if string(content) != `["outside"]` {
		t.Fatal("outside file changed")
	}
}

func TestConfigImportRollsBackFilesWhenPreferenceSaveFails(t *testing.T) {
	h, dir := newConfigTransferTestHandler(t)
	writeJSON(t, filepath.Join(dir, "prompts.json"), []string{"original"})
	// The preference destination is a directory, causing the final save to fail.
	if err := os.Mkdir(filepath.Join(dir, "preferences.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "preferences.json", "blocker"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := configArchive{Format: transferFormat, Version: 1, Sections: map[string]json.RawMessage{
		"prompts":  transferJSON([]string{"imported"}),
		"behavior": transferJSON(map[string]any{"session_naming": map[string]any{}, "idle_session_resource_release_hours": 12, "new_project_meta_location": "home"}),
	}}
	if _, err := h.importConfig(a, []string{"prompts", "behavior"}); err == nil {
		t.Fatal("expected storage failure")
	}
	var items []string
	_ = readTransferJSON(filepath.Join(dir, "prompts.json"), &items)
	if len(items) != 1 || items[0] != "original" {
		t.Fatal("file rollback failed")
	}
	if h.AppContext.Prefs.IdleSessionResourceReleaseHours() != 72 {
		t.Fatal("memory rollback failed")
	}
}

func TestConfigTransferHTTPRoutesAndInvalidInput(t *testing.T) {
	h, _ := newConfigTransferTestHandler(t)
	for _, tc := range []struct {
		path, body string
		status     int
	}{
		{"/api/config/export", `{"categories":["behavior"]}`, http.StatusOK},
		{"/api/config/export", `{"categories":["device"]}`, http.StatusBadRequest},
		{"/api/config/import", `{"archive":{"format":"other","version":1},"categories":[]}`, http.StatusBadRequest},
		{"/api/config/import", `{} {}`, http.StatusBadRequest},
	} {
		request := httptest.NewRequest(http.MethodPost, tc.path, bytes.NewBufferString(tc.body))
		response := httptest.NewRecorder()
		h.Routes().ServeHTTP(response, request)
		if response.Code != tc.status {
			t.Fatalf("%s status %d: %s", tc.path, response.Code, response.Body.String())
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("configuration responses must not be cached")
		}
	}
}

func TestConfigTransferRequiresPairingWhenE2EEIsEnabled(t *testing.T) {
	h, _ := newConfigTransferTestHandler(t)
	h.AppContext.E2EE = e2ee.NewManager(e2ee.Config{Enabled: true, NodeID: "this-device", PairingSecret: "pairing-secret"})
	for _, path := range []string{"/api/config/export", "/api/config/import"} {
		response := httptest.NewRecorder()
		h.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`)))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("unpaired request to %s was allowed: %d", path, response.Code)
		}
	}
}
