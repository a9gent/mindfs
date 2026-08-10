package api

import (
	"path/filepath"
	"testing"

	"mindfs/server/internal/agent"
)

func TestApplyClaudeAPIProviderReplacesConfiguredEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	configPath := filepath.Join(home, "agents.json")
	t.Setenv("MINDFS_AGENTS_CONFIG", configPath)

	writeJSON(t, configPath, agent.Config{
		Agents: []agent.Definition{
			{
				Name:     "claude",
				Command:  "claude",
				Protocol: agent.ProtocolClaudeSDK,
				Env: map[string]string{
					"ANTHROPIC_AUTH_TOKEN": "old-token",
					"ANTHROPIC_BASE_URL":   "https://old.example.com",
					"ANTHROPIC_API_KEY":    "old-key",
					"ANTHROPIC_MODEL":      "old-model",
					"KEEP_ME":              "unchanged",
				},
				ConfigBackup: agent.ConfigBackupDefaults{
					EnvKeys: []string{
						"ANTHROPIC_AUTH_TOKEN",
						"ANTHROPIC_BASE_URL",
						"ANTHROPIC_API_KEY",
						"ANTHROPIC_MODEL",
					},
				},
			},
		},
	})

	err := applyAgentAPIProvider("claude", agentAPIProvider{
		BaseURL: "https://new.example.com",
		APIKey:  "new-key",
	}, nil)
	if err != nil {
		t.Fatalf("applyAgentAPIProvider: %v", err)
	}

	cfg, err := agent.LoadConfig("")
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	def, ok := cfg.GetAgent("claude")
	if !ok {
		t.Fatal("claude not configured")
	}
	want := map[string]string{
		"ANTHROPIC_BASE_URL":   "https://new.example.com",
		"ANTHROPIC_AUTH_TOKEN": "new-key",
		"KEEP_ME":              "unchanged",
	}
	if !stringMapsEqual(def.Env, want) {
		t.Fatalf("claude env = %#v, want %#v", def.Env, want)
	}
}

func stringMapsEqual(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}
