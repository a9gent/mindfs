package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mindfs/server/internal/agent"
)

func TestPrunePinnedModels(t *testing.T) {
	// 顺序保持，已下架的剔除
	got := prunePinnedModels([]string{"kimi-k3", "glm-5.3-flash", "deepseek-v4"}, []string{"deepseek-v4", "kimi-k3"})
	if len(got) != 2 || got[0] != "kimi-k3" || got[1] != "deepseek-v4" {
		t.Fatalf("prunePinnedModels = %v, want pinned order minus gone models", got)
	}
	// 空精选原样返回（全量语义不被误清）
	if got := prunePinnedModels(nil, []string{"a"}); got != nil {
		t.Fatalf("empty pinned should pass through, got %v", got)
	}
	// 全部下架 → 空投影（调用方需据此跳过 default_model 写入）
	if got := prunePinnedModels([]string{"x"}, []string{"y"}); len(got) != 0 {
		t.Fatalf("all-gone pinned should prune to empty, got %v", got)
	}
	// 前后空格按 trim 后匹配
	if got := prunePinnedModels([]string{" a "}, []string{"a"}); len(got) != 1 || got[0] != "a" {
		t.Fatalf("trim match failed: %v", got)
	}
}

func TestMFSProviderRuleIDEdgeCases(t *testing.T) {
	cases := map[string]string{
		"api-cpa0":  "mfs-api-cpa0",
		" api-cpa ": "mfs-api-cpa",   // 首尾空白先 trim，不能产生 mfs--api
		"API.CPA_0": "mfs-api-cpa-0", // 大写折叠、分隔符统一成单个 -
		"模型api":     "mfs-api",       // 非 ASCII 丢弃
		"---":       "mfs",           // 全分隔符 id 不产生悬空连字符
	}
	for input, want := range cases {
		if got := agent.MFSProviderRuleID(input); got != want {
			t.Fatalf("MFSProviderRuleID(%q) = %q, want %q", input, got, want)
		}
	}
}

// apiProviderFixture is a provider with a pinned subset, used by the writers
// below to check what they project into each agent's config.
func apiProviderFixture() agentAPIProvider {
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

func TestBackupAgentConfigFilePrunesOldCopies(t *testing.T) {
	target := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(target, []byte("current"), 0o600); err != nil {
		t.Fatal(err)
	}
	// 预置 7 份时间戳递增的旧备份（固定宽度后缀，字典序即时间序）
	for i := 0; i < 7; i++ {
		name := target + ".bak-20260101-00000" + string(rune('0'+i))
		if err := os.WriteFile(name, []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := backupAgentConfigFile(target); err != nil {
		t.Fatal(err)
	}
	matches, _ := filepath.Glob(target + ".bak-*")
	if len(matches) != agentConfigBackupKeep {
		t.Fatalf("backups = %d, want %d", len(matches), agentConfigBackupKeep)
	}
	// 最旧的两份被剪掉，最新的旧备份和本次新备份都在
	if _, err := os.Stat(target + ".bak-20260101-000006"); err != nil {
		t.Fatalf("newest old backup pruned by mistake: %v", err)
	}
}

func TestApplyKimiAPIProviderOmitsEmptyModelSelection(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".kimi"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".kimi", "config.toml")
	seed := `# BEGIN MINDFS API PROVIDER
default_model = "old-model"

[providers.mfs-api-cpa]
type = "openai_legacy"
base_url = "http://old"
api_key = "sk-old"

[models.mfs-api-cpa]
provider = "mfs-api-cpa"
model = "old-model"
# END MINDFS API PROVIDER
`
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	provider := apiProviderFixture()
	provider.Models = nil
	provider.PinnedModels = nil
	if err := applyKimiAPIProvider(provider); err != nil {
		t.Fatalf("applyKimiAPIProvider: %v", err)
	}

	raw, _ := os.ReadFile(path)
	text := string(raw)
	if strings.Contains(text, `default_model = ""`) || strings.Contains(text, `model = ""`) {
		t.Fatalf("empty projection wrote empty model selection: %s", text)
	}
	if strings.Contains(text, "old-model") {
		t.Fatalf("stale model selection survived: %s", text)
	}
	if !strings.Contains(text, "sk-test") || !strings.Contains(text, "[providers.CPA]") {
		t.Fatalf("provider definition missing: %s", text)
	}
}

func TestApplyQwenAPIProviderKeepsModelNameOnEmptyProjection(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".qwen"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".qwen", "settings.json")
	seed := `{"model":{"name":"old-model"},"env":{}}`
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	provider := apiProviderFixture()
	provider.Models = nil
	provider.PinnedModels = nil
	if err := applyQwenAPIProvider(provider); err != nil {
		t.Fatalf("applyQwenAPIProvider: %v", err)
	}

	raw, _ := os.ReadFile(path)
	var settings map[string]any
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	if got := settings["model"].(map[string]any)["name"]; got != "old-model" {
		t.Fatalf("model.name = %v, want old value kept on empty projection", got)
	}
	modelProviders := settings["modelProviders"].(map[string]any)
	if _, ok := modelProviders["anthropic"]; !ok {
		t.Fatalf("provider entry missing: %v", modelProviders)
	}
}
