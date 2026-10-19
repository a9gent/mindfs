package agent

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"

	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/config"
)

// ACP agents often report a thin model catalog: the
// app-server's session/read may only echo the current model. When the agent is
// bound to a MindFS API provider (last_config_selection), the provider's
// projection list (PinnedModels ∩ Models, or all Models) is merged into the
// probed catalog as `<providerId>␟<modelId>` entries — the exact id shape the
// bridge itself emits after MindFS projects the rule into its config, so
// selection round-trips through session/set_model unchanged.

type acpProviderRecord struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Models       []string `json:"models"`
	PinnedModels []string `json:"pinnedModels"`
}

type acpSelectionRecord struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func supplementACPProviderModels(status *Status) {
	if status == nil || status.Protocol != ProtocolACP {
		return
	}
	selection, ok := acpLastConfigSelection(status.Name)
	if !ok || selection.Type != "api_provider" || strings.TrimSpace(selection.ID) == "" {
		return
	}
	provider, ok := acpProviderByID(selection.ID)
	if !ok {
		return
	}
	models := acpProviderProjection(provider)
	if len(models) == 0 {
		return
	}
	ruleID := MFSProviderRuleID(provider.ID)
	providerName := strings.TrimSpace(provider.Name)
	if providerName == "" {
		providerName = ruleID
	}
	seen := make(map[string]struct{}, len(status.Models))
	for _, m := range status.Models {
		seen[strings.TrimSpace(m.ID)] = struct{}{}
	}
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		id := ruleID + "␟" + model
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		status.Models = append(status.Models, agenttypes.ModelInfo{
			ID:   id,
			Name: model + " · " + providerName,
		})
	}
}

// MFSProviderRuleID derives the mfs-managed provider rule id (mfs-<slug>)
// used in the `<ruleID>␟<model>` ids this supplement emits, so a bridge that
// projects the same rule id sees the selection round-trip unchanged.
func MFSProviderRuleID(providerID string) string {
	var b strings.Builder
	b.WriteString("mfs-")
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(providerID)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		case r == '.' || r == '_' || r == '-' || r == ' ':
			if !lastDash && b.Len() > 4 {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

func acpProviderProjection(provider acpProviderRecord) []string {
	if len(provider.PinnedModels) == 0 {
		return provider.Models
	}
	available := make(map[string]struct{}, len(provider.Models))
	for _, model := range provider.Models {
		available[strings.TrimSpace(model)] = struct{}{}
	}
	out := make([]string, 0, len(provider.PinnedModels))
	seen := make(map[string]struct{}, len(provider.PinnedModels))
	for _, model := range provider.PinnedModels {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		if _, ok := available[model]; !ok {
			continue
		}
		seen[model] = struct{}{}
		out = append(out, model)
	}
	return out
}

func acpLastConfigSelection(agentName string) (acpSelectionRecord, bool) {
	var payload struct {
		Agents map[string]struct {
			LastConfigSelection *acpSelectionRecord `json:"last_config_selection"`
		} `json:"agents"`
	}
	if !acpReadConfigJSON("preferences.json", &payload) {
		return acpSelectionRecord{}, false
	}
	entry, ok := payload.Agents[strings.TrimSpace(agentName)]
	if !ok || entry.LastConfigSelection == nil {
		return acpSelectionRecord{}, false
	}
	return *entry.LastConfigSelection, true
}

func acpProviderByID(providerID string) (acpProviderRecord, bool) {
	var providers []acpProviderRecord
	if !acpReadConfigJSON("api-providers.json", &providers) {
		return acpProviderRecord{}, false
	}
	providerID = strings.TrimSpace(providerID)
	for _, provider := range providers {
		if strings.TrimSpace(provider.ID) == providerID {
			return provider, true
		}
	}
	return acpProviderRecord{}, false
}

// acpReadConfigJSON reads a MindFS config-dir file directly. The preferences
// package imports this package, so the binding relationship is read from disk
// instead of via an import (same escape hatch codex/session.go uses).
func acpReadConfigJSON(name string, target any) bool {
	configDir, err := config.MindFSConfigDir()
	if err != nil {
		return false
	}
	payload, err := os.ReadFile(filepath.Join(configDir, name))
	if err != nil {
		return false
	}
	if err := json.Unmarshal(payload, target); err != nil {
		log.Printf("[agent/acp-supplement] parse.error file=%s err=%v", name, err)
		return false
	}
	return true
}
