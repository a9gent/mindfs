package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

func TestSwitchAgentConfigPreservesProviderForCustomNamedCodexAgent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	configPath := filepath.Join(home, "agents.json")
	t.Setenv("MINDFS_AGENTS_CONFIG", configPath)
	writeJSON(t, configPath, agent.Config{Agents: []agent.Definition{{Name: "codex-custom", Command: "codex", Protocol: agent.ProtocolCodexSDK}}})

	targetPath := filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		t.Fatalf("mkdir current config: %v", err)
	}
	if err := os.WriteFile(targetPath, []byte("model_provider = \"custom\"\n[model_providers.custom]\nname = \"current\"\n"), 0o600); err != nil {
		t.Fatalf("write current config: %v", err)
	}
	configRoot, err := agentConfigRootDir()
	if err != nil {
		t.Fatalf("agentConfigRootDir: %v", err)
	}
	backupPath := filepath.Join(configRoot, "codex-target", "config.toml")
	if err := os.MkdirAll(filepath.Dir(backupPath), 0o755); err != nil {
		t.Fatalf("mkdir backup: %v", err)
	}
	if err := os.WriteFile(backupPath, []byte("model_provider = \"target\"\n[model_providers.target]\nname = \"target\"\n"), 0o600); err != nil {
		t.Fatalf("write backup: %v", err)
	}
	entry := agentConfigManifestEntry{
		ID: "codex-target", Agent: "codex-custom", Name: "target",
		Sources: []agentConfigSource{{SourcePath: "~/.codex/config.toml", BackupPath: "codex-target/config.toml"}},
	}
	if err := writeAgentConfigManifest([]agentConfigManifestEntry{entry}); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if _, needsConfirm, err := switchAgentConfig(agentConfigSwitchRequest{ID: entry.ID, ConfirmOverwrite: true}, nil); err != nil || needsConfirm {
		t.Fatalf("switchAgentConfig: needsConfirm=%t err=%v", needsConfirm, err)
	}
	payload, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("read switched config: %v", err)
	}
	got := string(payload)
	if !strings.Contains(got, `model_provider = "custom"`) || !strings.Contains(got, "[model_providers.custom]") || strings.Contains(got, "[model_providers.target]") {
		t.Fatalf("switched config changed channel identity: %s", got)
	}
}

func TestSwitchAgentConfigDoesNotRewriteOtherConfigTomlFiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	configPath := filepath.Join(home, "agents.json")
	t.Setenv("MINDFS_AGENTS_CONFIG", configPath)
	writeJSON(t, configPath, agent.Config{Agents: []agent.Definition{{Name: "codex", Command: "codex", Protocol: agent.ProtocolCodexSDK}}})

	codexPath := filepath.Join(home, ".codex", "config.toml")
	otherPath := filepath.Join(home, "project", "config.toml")
	if err := os.MkdirAll(filepath.Dir(codexPath), 0o755); err != nil {
		t.Fatalf("mkdir codex config: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(otherPath), 0o755); err != nil {
		t.Fatalf("mkdir other config: %v", err)
	}
	if err := os.WriteFile(codexPath, []byte("model_provider = \"custom\"\n[model_providers.custom]\nname = \"current\"\n"), 0o600); err != nil {
		t.Fatalf("write current config: %v", err)
	}
	if err := os.WriteFile(otherPath, []byte("model_provider = \"project\"\n[model_providers.project]\nname = \"current-project\"\n"), 0o600); err != nil {
		t.Fatalf("write other config: %v", err)
	}
	configRoot, err := agentConfigRootDir()
	if err != nil {
		t.Fatalf("agentConfigRootDir: %v", err)
	}
	for path, payload := range map[string]string{
		filepath.Join(configRoot, "codex-target", "codex.toml"):   "model_provider = \"target\"\n[model_providers.target]\nname = \"target\"\n",
		filepath.Join(configRoot, "codex-target", "project.toml"): "model_provider = \"project\"\n[model_providers.project]\nname = \"backup-project\"\n",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir backup: %v", err)
		}
		if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
			t.Fatalf("write backup: %v", err)
		}
	}
	entry := agentConfigManifestEntry{ID: "codex-target", Agent: "codex", Name: "target", Sources: []agentConfigSource{
		{SourcePath: "~/.codex/config.toml", BackupPath: "codex-target/codex.toml"},
		{SourcePath: "~/project/config.toml", BackupPath: "codex-target/project.toml"},
	}}
	if err := writeAgentConfigManifest([]agentConfigManifestEntry{entry}); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if _, needsConfirm, err := switchAgentConfig(agentConfigSwitchRequest{ID: entry.ID, ConfirmOverwrite: true}, nil); err != nil || needsConfirm {
		t.Fatalf("switchAgentConfig: needsConfirm=%t err=%v", needsConfirm, err)
	}
	payload, err := os.ReadFile(otherPath)
	if err != nil {
		t.Fatalf("read other config: %v", err)
	}
	if got := string(payload); got != "model_provider = \"project\"\n[model_providers.project]\nname = \"backup-project\"\n" {
		t.Fatalf("other config was unexpectedly normalized: %s", got)
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
