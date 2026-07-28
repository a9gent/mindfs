package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"mindfs/server/internal/agent"
)

func TestSwitchAgentConfigClearsExistingEnvWhenBackupHasNoEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	configPath := filepath.Join(home, "agents.json")
	t.Setenv("MINDFS_AGENTS_CONFIG", configPath)

	initial := agent.Config{
		Agents: []agent.Definition{
			{
				Name:     "codex",
				Command:  "codex",
				Protocol: agent.ProtocolCodexSDK,
				Env: map[string]string{
					"OPENAI_API_KEY":  "old-key",
					"OPENAI_BASE_URL": "https://old.example.com",
				},
			},
		},
	}
	writeJSON(t, configPath, initial)

	configRoot, err := agentConfigRootDir()
	if err != nil {
		t.Fatalf("agentConfigRootDir: %v", err)
	}
	backupPath := filepath.Join(configRoot, "codex-file", "config.toml")
	if err := os.MkdirAll(filepath.Dir(backupPath), 0o755); err != nil {
		t.Fatalf("mkdir backup: %v", err)
	}
	if err := os.WriteFile(backupPath, []byte("model_provider = \"new\"\n"), 0o600); err != nil {
		t.Fatalf("write backup: %v", err)
	}
	entry := agentConfigManifestEntry{
		ID:    "codex-file",
		Agent: "codex",
		Name:  "file",
		Sources: []agentConfigSource{
			{SourcePath: "~/target-config.toml", BackupPath: "codex-file/config.toml"},
		},
	}
	if err := writeAgentConfigManifest([]agentConfigManifestEntry{entry}); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	_, needsConfirm, err := switchAgentConfig(agentConfigSwitchRequest{
		ID:               entry.ID,
		ConfirmOverwrite: true,
	}, nil)
	if err != nil {
		t.Fatalf("switchAgentConfig: %v", err)
	}
	if needsConfirm {
		t.Fatalf("switchAgentConfig unexpectedly needs confirm")
	}

	cfg, err := agent.LoadConfig("")
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	def, ok := cfg.GetAgent("codex")
	if !ok {
		t.Fatalf("codex not configured")
	}
	if len(def.Env) != 0 {
		t.Fatalf("env should be cleared after file-only switch, got %#v", def.Env)
	}
}

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatalf("marshal json: %v", err)
	}
	payload = append(payload, '\n')
	if err := os.WriteFile(path, payload, 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
