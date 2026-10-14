package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mindfs/server/internal/agent"
)

func withAgentDefinition(t *testing.T, def agent.Definition) {
	t.Helper()
	previous := agentDefinitionForName
	agentDefinitionForName = func(string) (agent.Definition, bool) { return def, true }
	t.Cleanup(func() { agentDefinitionForName = previous })
}

func zcodeTestProvider() agentAPIProvider {
	return agentAPIProvider{
		ID:           "api-cpa",
		Name:         "CPA",
		BaseURL:      "http://cpa.test:8317",
		APIKey:       "sk-test",
		Protocols:    []string{apiProviderProtocolAnthropicCompatible},
		Models:       []string{"glm-5.3-flash", "deepseek-v4", "kimi-k3"},
		PinnedModels: []string{"kimi-k3", "glm-5.3-flash"},
	}
}

func zcodeBridgeDefinition(home string) agent.Definition {
	return agent.Definition{
		Name:    "zcode-1",
		Command: "zcode-acp-bridge",
		Env:     map[string]string{"BRIDGE_ZCODE_HOME": home},
	}
}

func readZcodeRule(t *testing.T, path, ruleID string) map[string]any {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read provider_config: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(payload, &doc); err != nil {
		t.Fatalf("parse provider_config: %v", err)
	}
	config := doc["config"].(map[string]any)
	rules := config["providerConfigRules"].(map[string]any)["providerRules"].([]any)
	for _, item := range rules {
		rule := item.(map[string]any)
		if rule["providerId"] == ruleID {
			return rule
		}
	}
	t.Fatalf("rule %q not found in %s", ruleID, path)
	return nil
}

func TestApplyZcodeAPIProviderCreatesRuleAndAppendsOrder(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".zcode", "v2")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	seed := `{"schemaVersion":1,"config":{"providerOrder":["new-provider"],"providerConfigRules":{"providerRules":[{"providerId":"new-provider","providerName":"新供应商","config":{"group":"standard-personal","access":{"type":"api-key","apiKey":"user-key"},"api":{"type":"anthropic-messages","baseUrl":"http://cpa.test:8317/v1"},"personalModelIds":["a","b"]}}]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}}}`
	if err := os.WriteFile(filepath.Join(dir, "provider_config.json"), []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	withAgentDefinition(t, zcodeBridgeDefinition(home))

	provider := zcodeTestProvider()
	if err := applyZcodeAPIProvider("zcode-1", provider); err != nil {
		t.Fatalf("applyZcodeAPIProvider: %v", err)
	}

	path := filepath.Join(dir, "provider_config.json")
	rule := readZcodeRule(t, path, "mfs-api-cpa")
	config := rule["config"].(map[string]any)
	if got := config["group"]; got != "standard-personal" {
		t.Fatalf("group = %v", got)
	}
	access := config["access"].(map[string]any)
	if access["apiKey"] != "sk-test" {
		t.Fatalf("apiKey not projected")
	}
	api := config["api"].(map[string]any)
	if api["type"] != "anthropic-messages" || api["baseUrl"] != "http://cpa.test:8317/v1" {
		t.Fatalf("api projection wrong: %v / %v", api["type"], api["baseUrl"])
	}
	models := zcodeStringSlice(config, "personalModelIds")
	if len(models) != 2 || models[0] != "kimi-k3" || models[1] != "glm-5.3-flash" {
		t.Fatalf("personalModelIds = %v, want pinned subset in pinned order", models)
	}

	var doc map[string]any
	payload, _ := os.ReadFile(path)
	_ = json.Unmarshal(payload, &doc)
	order := zcodeStringSlice(doc["config"].(map[string]any), "providerOrder")
	if len(order) != 2 || order[0] != "new-provider" || order[1] != "mfs-api-cpa" {
		t.Fatalf("providerOrder = %v, want existing entry kept and mfs rule appended", order)
	}

	// 用户已有 rule 的 personalModelIds 不能被动
	userRule := readZcodeRule(t, path, "new-provider")
	userModels := zcodeStringSlice(userRule["config"].(map[string]any), "personalModelIds")
	if len(userModels) != 2 || userModels[0] != "a" {
		t.Fatalf("user rule was modified: %v", userModels)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	hasBackup := false
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "provider_config.json.bak-") {
			hasBackup = true
			info, err := entry.Info()
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("backup perm = %v, want 0600", info.Mode().Perm())
			}
		}
	}
	if !hasBackup {
		t.Fatalf("no .bak backup created in %s", dir)
	}
}

func TestApplyZcodeAPIProviderUpdatesExistingManagedRuleInPlace(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".zcode", "v2")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	seed := `{"schemaVersion":1,"config":{"providerOrder":["mfs-api-cpa","new-provider"],"providerConfigRules":{"providerRules":[{"providerId":"mfs-api-cpa","providerName":"old","config":{"group":"standard-personal","access":{"type":"api-key","apiKey":"old"},"api":{"type":"anthropic-messages","baseUrl":"http://old/v1"},"personalModelIds":["x"]}}]}}}`
	path := filepath.Join(dir, "provider_config.json")
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	withAgentDefinition(t, zcodeBridgeDefinition(home))

	provider := zcodeTestProvider()
	provider.Models = []string{"glm-5.3-flash"}
	provider.PinnedModels = []string{"glm-5.3-flash"}
	if err := applyZcodeAPIProvider("zcode-1", provider); err != nil {
		t.Fatalf("applyZcodeAPIProvider: %v", err)
	}

	var doc map[string]any
	payload, _ := os.ReadFile(path)
	if err := json.Unmarshal(payload, &doc); err != nil {
		t.Fatal(err)
	}
	rules := doc["config"].(map[string]any)["providerConfigRules"].(map[string]any)["providerRules"].([]any)
	if len(rules) != 1 {
		t.Fatalf("rules = %d, want 1 (managed rule updated in place)", len(rules))
	}
	rule := rules[0].(map[string]any)
	if rule["providerName"] != "CPA" {
		t.Fatalf("providerName = %v, want refreshed", rule["providerName"])
	}
	order := zcodeStringSlice(doc["config"].(map[string]any), "providerOrder")
	if len(order) != 2 || order[0] != "mfs-api-cpa" {
		t.Fatalf("providerOrder = %v, want unchanged on in-place update", order)
	}
}

func TestApplyZcodeAPIProviderAbortsOnUnparsableConfig(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".zcode", "v2")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "provider_config.json")
	broken := `{"schemaVersion":1,"config":{"providerOrder":[`
	if err := os.WriteFile(path, []byte(broken), 0o600); err != nil {
		t.Fatal(err)
	}
	withAgentDefinition(t, zcodeBridgeDefinition(home))

	err := applyZcodeAPIProvider("zcode-1", zcodeTestProvider())
	if err == nil {
		t.Fatalf("expected parse error, got nil")
	}
	payload, _ := os.ReadFile(path)
	if string(payload) != broken {
		t.Fatalf("broken config was overwritten")
	}
}

func TestApplyZcodeAPIProviderRequiresBridgeHome(t *testing.T) {
	withAgentDefinition(t, agent.Definition{Name: "zcode-1", Command: "zcode-acp-bridge"})
	err := applyZcodeAPIProvider("zcode-1", zcodeTestProvider())
	if err == nil {
		t.Fatalf("expected bridge home error, got nil")
	}
}

func TestProviderProjectionPinnedIntersectionKeepsOrder(t *testing.T) {
	provider := agentAPIProvider{
		Models:       []string{"a", "b", "c", "d"},
		PinnedModels: []string{"d", "stale", "b", "b"},
	}
	got := providerProjection(provider)
	if len(got) != 2 || got[0] != "d" || got[1] != "b" {
		t.Fatalf("providerProjection = %v, want [d b]", got)
	}
	if full := providerProjection(agentAPIProvider{Models: []string{"a"}}); len(full) != 1 {
		t.Fatalf("empty pinned must fall back to full models")
	}
}

func TestMFSProviderRuleIDSlugsProviderID(t *testing.T) {
	if got := mfsProviderRuleID("api-cpa0"); got != "mfs-api-cpa0" {
		t.Fatalf("mfsProviderRuleID = %q", got)
	}
	if got := mfsProviderRuleID("My Provider_v2.X"); got != "mfs-my-provider-v2-x" {
		t.Fatalf("mfsProviderRuleID = %q", got)
	}
}
