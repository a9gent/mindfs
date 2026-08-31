package api

import (
	"path/filepath"
	"strings"
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

func TestMergeCodexAPIProviderConfigKeepsExistingModelProviderKey(t *testing.T) {
	existing := `model_provider = "custom"
model = "old-model"

[model_providers.custom]
name = "old"
base_url = "https://old.example.com/v1"
experimental_bearer_token = "old-key"
`
	got := mergeCodexAPIProviderConfig(existing, agentAPIProvider{
		Name:    "new-profile",
		Models:  []string{"new-model"},
		BaseURL: "https://new.example.com",
		APIKey:  "new-key",
	})
	if !strings.Contains(got, `model_provider = "custom"`) {
		t.Fatalf("model_provider key changed: %s", got)
	}
	if strings.Contains(got, "model_provider = \"new-profile\"") || strings.Contains(got, "[model_providers.new-profile]") {
		t.Fatalf("new profile name leaked into channel key: %s", got)
	}
	if !strings.Contains(got, "[model_providers.custom]") || !strings.Contains(got, `name = "new-profile"`) {
		t.Fatalf("provider table was not updated: %s", got)
	}
	if strings.Contains(got, "model =") {
		t.Fatalf("model should be left unset for Codex to choose: %s", got)
	}
}

func TestMergeCodexAPIProviderConfigReplacesQuotedProviderTable(t *testing.T) {
	existing := `model_provider = "custom"

[model_providers."custom"]
name = "old"
base_url = "https://old.example.com/v1"
`
	got := mergeCodexAPIProviderConfig(existing, agentAPIProvider{
		Name:    "new-profile",
		BaseURL: "https://new.example.com",
		APIKey:  "new-key",
	})
	if strings.Contains(got, `[model_providers."custom"]`) {
		t.Fatalf("quoted provider table was not replaced: %s", got)
	}
	if count := strings.Count(got, "[model_providers.custom]"); count != 1 {
		t.Fatalf("provider table count = %d, want 1: %s", count, got)
	}
	if strings.Contains(got, `base_url = "https://old.example.com/v1"`) {
		t.Fatalf("old provider settings were retained: %s", got)
	}
}

func TestMergeCodexAPIProviderConfigOmitsModelWhenProviderHasNoCatalog(t *testing.T) {
	got := mergeCodexAPIProviderConfig(`model_provider = "custom"
model = "old-model"
`, agentAPIProvider{Name: "profile", BaseURL: "https://example.com", APIKey: "key"})
	if strings.Contains(got, "model =") {
		t.Fatalf("model should be omitted when provider has no model catalog: %s", got)
	}
}

func TestMergeCodexAPIProviderConfigKeepsExistingModelWhenProviderAdvertisesIt(t *testing.T) {
	got := mergeCodexAPIProviderConfig(`model_provider = "custom"
model = "shared-model"

[model_providers.custom]
name = "old"
`, agentAPIProvider{
		Name:    "profile",
		Models:  []string{"other-model", " shared-model "},
		BaseURL: "https://example.com",
		APIKey:  "key",
	})
	if !strings.Contains(got, `model = "shared-model"`) {
		t.Fatalf("existing compatible model was not preserved: %s", got)
	}
}

func TestCodexModelProviderFromConfigParsesCommentsAndQuotedValues(t *testing.T) {
	if got := codexModelProviderFromConfig("model_provider = \"custom\" # keep this key\n[model_providers.custom]\n"); got != "custom" {
		t.Fatalf("commented provider = %q, want custom", got)
	}
	if got := codexModelProviderFromConfig("model_provider = 'custom'\n[model_providers.custom]\n"); got != "custom" {
		t.Fatalf("literal provider = %q, want custom", got)
	}
}

func TestPreserveCodexModelProviderKeyRenamesCopiedProviderTable(t *testing.T) {
	existing := `model_provider = "target"
model = "gpt-5"

[model_providers."target"]
name = "target"
base_url = "https://target.example.com/v1"
`
	got := preserveCodexModelProviderKey(existing, "custom")
	if !strings.Contains(got, `model_provider = "custom"`) {
		t.Fatalf("top-level provider key not preserved: %s", got)
	}
	if !strings.Contains(got, "[model_providers.custom]") || strings.Contains(got, `[model_providers."target"]`) {
		t.Fatalf("provider table was not renamed: %s", got)
	}
}

func TestPreserveCodexModelProviderKeyAddsMissingTopLevelKey(t *testing.T) {
	existing := `[model_providers.custom]
name = "custom"
base_url = "https://custom.example.com/v1"
`
	got := preserveCodexModelProviderKey(existing, "custom")
	if !strings.Contains(got, `model_provider = "custom"`) {
		t.Fatalf("missing top-level provider key was not added: %s", got)
	}
	if !strings.Contains(got, "[model_providers.custom]") {
		t.Fatalf("provider table was changed: %s", got)
	}
}

func TestPreserveCodexModelProviderKeyLeavesBuiltinProviderWithoutTable(t *testing.T) {
	existing := `model_provider = "openai"
model = "gpt-5"
`
	got := preserveCodexModelProviderKey(existing, "custom")
	if got != existing {
		t.Fatalf("config without a provider table should remain unchanged: %q", got)
	}
}
