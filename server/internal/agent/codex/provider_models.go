package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"mindfs/server/internal/agent/types"
	"mindfs/server/internal/config"
)

// supplementSavedProviderModels augments model/list without changing Codex's
// native catalog or fetching a second catalog over the network. The binding is
// recorded by the existing provider-switch flow; match its ID, not a URL shared
// by potentially different accounts. Read on each call so provider syncs and
// config switches are reflected without a separate model cache.
func supplementSavedProviderModels(agentName string, models []types.ModelInfo) []types.ModelInfo {
	agentName = strings.TrimSpace(agentName)
	if agentName == "" {
		return models
	}
	dir, err := config.MindFSConfigDir()
	if err != nil {
		return models
	}
	// preferences imports agent, so decode only the binding fields here to avoid
	// introducing a dependency cycle through the preferences package.
	var prefs struct {
		Agents map[string]struct {
			Selection *struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			} `json:"last_config_selection"`
		} `json:"agents"`
	}
	if !readProviderModelJSON(filepath.Join(dir, "preferences.json"), &prefs) {
		return models
	}
	selection := prefs.Agents[agentName].Selection
	if selection == nil || selection.Type != "api_provider" || selection.ID == "" {
		return models
	}
	var providers []struct {
		ID     string   `json:"id"`
		Models []string `json:"models"`
	}
	if !readProviderModelJSON(filepath.Join(dir, "api-providers.json"), &providers) {
		return models
	}
	for _, provider := range providers {
		if provider.ID != selection.ID {
			continue
		}
		seen := make(map[string]bool, len(models))
		for _, model := range models {
			seen[strings.TrimSpace(model.ID)] = true
		}
		for _, raw := range provider.Models {
			id := strings.TrimSpace(raw)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			// A saved model ID does not establish reasoning effort support.
			models = append(models, types.ModelInfo{ID: id, Name: id})
		}
		break
	}
	return models
}

func readProviderModelJSON(path string, target any) bool {
	payload, err := os.ReadFile(path)
	return err == nil && json.Unmarshal(payload, target) == nil
}
