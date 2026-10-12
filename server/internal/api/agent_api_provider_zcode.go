package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/apperr"
)

// errZcodeBridgeHomeMissing marks a zcode agent without BRIDGE_ZCODE_HOME; the
// caller falls back to env injection for bare zcode installs.
var errZcodeBridgeHomeMissing = errors.New("zcode bridge home not configured")

// zcodeACPAPIBaseURL is the /v1-suffixed base the anthropic-messages API type
// expects (matches the CLIProxyAPI rule zcode itself wrote).
const zcodeACPAPIBaseURLSuffix = "/v1"

// applyZcodeAPIProvider projects the provider's curated model list into the
// bridge home's ~/.zcode/v2/provider_config.json as an mfs-<id> provider rule.
// Only rules whose providerId is mfs-managed are ever touched — user-created
// rules, their order relative to each other, and credentials.json stay intact.
func applyZcodeAPIProvider(agentName string, provider agentAPIProvider) error {
	def, ok := agentDefinitionForName(agentName)
	if !ok {
		return fmt.Errorf("agent not configured: %s", agentName)
	}
	home := strings.TrimSpace(def.Env["BRIDGE_ZCODE_HOME"])
	if home == "" {
		return errZcodeBridgeHomeMissing
	}
	path := filepath.Join(home, ".zcode", "v2", "provider_config.json")
	payload, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return apperr.Wrap("read", path, err)
	}
	var doc map[string]any
	if len(strings.TrimSpace(string(payload))) > 0 {
		// 严格 JSON：provider_config.json 是 zcode 自己的配置，不做 JSONC 容错，
		// 解析失败就中止，绝不截断重写。
		if err := json.Unmarshal(payload, &doc); err != nil {
			return fmt.Errorf("parse %s: %w (refusing to overwrite unreadable config)", path, err)
		}
	}
	if doc == nil {
		doc = map[string]any{}
	}

	config := ensureJSONObject(doc, "config")
	if _, ok := config["schemaVersion"]; !ok && doc["schemaVersion"] == nil {
		doc["schemaVersion"] = 1
	}
	order := zcodeStringSlice(config, "providerOrder")
	rules := zcodeProviderRules(config)

	ruleID := mfsProviderRuleID(provider.ID)
	projection := providerProjection(provider)
	entry := map[string]any{
		"providerId":   ruleID,
		"providerName": agentAPIProviderConfigName(provider),
		"config": map[string]any{
			"group":  "standard-personal",
			"access": map[string]any{"type": "api-key", "apiKey": provider.APIKey},
			"api": map[string]any{
				"type":    zcodeAPIType(agentAPIProviderActiveProtocol(provider)),
				"baseUrl": zcodeAPIBaseURL(provider.BaseURL),
			},
			"personalModelIds": projection,
		},
	}

	index := -1
	for i, rule := range rules {
		if id, _ := rule["providerId"].(string); id == ruleID {
			index = i
			break
		}
	}
	if index >= 0 {
		rules[index] = entry
	} else {
		rules = append(rules, entry)
		if !containsString(order, ruleID) {
			order = append(order, ruleID)
		}
	}
	config["providerOrder"] = order
	ensureJSONObject(config, "providerConfigRules")["providerRules"] = rules

	if err := backupAgentConfigFile(path); err != nil {
		return err
	}
	return writeJSONObject(path, doc, 0o600)
}

func zcodeProviderRules(config map[string]any) []map[string]any {
	wrapper := ensureJSONObject(config, "providerConfigRules")
	raw, _ := wrapper["providerRules"].([]any)
	rules := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if rule, ok := item.(map[string]any); ok {
			rules = append(rules, rule)
		}
	}
	return rules
}

func zcodeStringSlice(parent map[string]any, key string) []string {
	raw, _ := parent[key].([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			out = append(out, text)
		}
	}
	return out
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// zcodeAPIType maps a MindFS provider protocol onto zcode's api.type values.
// "anthropic-messages" is verified against a live provider_config.json;
// openai/gemini follow the same naming family as pi's writer.
func zcodeAPIType(protocol string) string {
	switch protocol {
	case apiProviderProtocolAnthropicCompatible:
		return "anthropic-messages"
	case apiProviderProtocolGeminiCompatible:
		return "google-generative-ai"
	default:
		return "openai-completions"
	}
}

func zcodeAPIBaseURL(baseURL string) string {
	base := strings.TrimRight(baseURL, "/")
	if strings.HasSuffix(base, zcodeACPAPIBaseURLSuffix) {
		return base
	}
	return base + zcodeACPAPIBaseURLSuffix
}

// mfsProviderRuleID derives the managed provider rule id (mfs-<slug>). The
// single implementation lives in agent.MFSProviderRuleID — the ACP supplement
// encodes ids as <ruleID>␟<model> and must match this projection exactly.
func mfsProviderRuleID(providerID string) string {
	return agent.MFSProviderRuleID(providerID)
}

// removeZcodeAPIProviderRules strips the mfs-managed rule (and its
// providerOrder entry) for a deleted provider from every configured zcode
// bridge home. Best-effort: homes that are missing or whose config can't be
// parsed are skipped with a log line — deleting the provider in MindFS must
// never fail, but the rule holding its API key should not outlive it.
func removeZcodeAPIProviderRules(providerID string) {
	ruleID := mfsProviderRuleID(providerID)
	if ruleID == "" || ruleID == "mfs-" {
		return
	}
	cfg, err := agent.LoadConfig("")
	if err != nil {
		log.Printf("[agent-api-provider] zcode rule cleanup skipped: load config: %v", err)
		return
	}
	for _, def := range cfg.Agents {
		home := strings.TrimSpace(def.Env["BRIDGE_ZCODE_HOME"])
		if home == "" {
			continue
		}
		removed, err := removeZcodeProviderRule(home, ruleID)
		if err != nil {
			log.Printf("[agent-api-provider] zcode rule cleanup %s (%s): %v", def.Name, home, err)
			continue
		}
		if removed {
			log.Printf("[agent-api-provider] zcode rule cleanup removed %s from %s (%s)", ruleID, def.Name, home)
		}
	}
}

// removeZcodeProviderRule removes one mfs-managed rule and its providerOrder
// entry from the given bridge home's provider_config.json. Returns whether
// anything was rewritten.
func removeZcodeProviderRule(home, ruleID string) (bool, error) {
	path := filepath.Join(home, ".zcode", "v2", "provider_config.json")
	payload, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, apperr.Wrap("read", path, err)
	}
	var doc map[string]any
	if len(strings.TrimSpace(string(payload))) > 0 {
		// 与写入侧同样的严格 JSON：解析不了就不动，绝不截断 zcode 的配置。
		if err := json.Unmarshal(payload, &doc); err != nil {
			return false, fmt.Errorf("parse %s: %w (refusing to modify unreadable config)", path, err)
		}
	}
	config, _ := doc["config"].(map[string]any)
	if config == nil {
		return false, nil
	}
	rules := zcodeProviderRules(config)
	nextRules := make([]map[string]any, 0, len(rules))
	removedRule := false
	for _, rule := range rules {
		if id, _ := rule["providerId"].(string); id == ruleID {
			removedRule = true
			continue
		}
		nextRules = append(nextRules, rule)
	}
	order := zcodeStringSlice(config, "providerOrder")
	nextOrder := make([]string, 0, len(order))
	removedOrder := false
	for _, id := range order {
		if id == ruleID {
			removedOrder = true
			continue
		}
		nextOrder = append(nextOrder, id)
	}
	if !removedRule && !removedOrder {
		return false, nil
	}
	if removedRule {
		ensureJSONObject(config, "providerConfigRules")["providerRules"] = nextRules
	}
	if removedOrder {
		config["providerOrder"] = nextOrder
	}
	if err := backupAgentConfigFile(path); err != nil {
		return false, err
	}
	return true, writeJSONObject(path, doc, 0o600)
}
