package claude

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	claudeagent "github.com/roasbeef/claude-agent-sdk-go"

	"mindfs/server/internal/agent/providermodels"
	"mindfs/server/internal/agent/types"
	"mindfs/server/internal/config"
	"mindfs/server/internal/testutil"
)

func claudeProviderModelFixture(t *testing.T) func(string, any) {
	t.Helper()
	testutil.IsolateUserDirs(t, t.TempDir())
	dir, err := config.MindFSConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return func(name string, value any) {
		t.Helper()
		payload, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), payload, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func claudeProviderSelection(id, kind string) map[string]any {
	return map[string]any{"agents": map[string]any{
		"claude-work": map[string]any{"last_config_selection": map[string]string{"type": kind, "id": id}},
		"claude":      map[string]any{"last_config_selection": map[string]string{"type": "api_provider", "id": "other-account"}},
	}}
}

func TestClaudeListModelsIncludesEveryBoundProviderFamily(t *testing.T) {
	write := claudeProviderModelFixture(t)
	write("preferences.json", claudeProviderSelection("auto-media", "api_provider"))
	write("api-providers.json", []any{
		map[string]any{"id": "other-account", "baseUrl": "https://gateway.test", "protocols": []string{"anthropic-compatible"}, "models": []string{"other-account-model"}},
		map[string]any{
			"id": "auto-media", "baseUrl": "https://gateway.test",
			"protocols":     []string{"openai-compatible", "anthropic-compatible"},
			"modelFamilies": []string{"anthropic", "deepseek", "glm", "kimi", "openai"},
			"models":        []string{"claude-test", " glm-test ", "deepseek-test", "kimi-test", "gpt-test", "", "glm-test"},
		},
	})

	// A client with an empty native catalog is enough: listing must not start a
	// CLI process or make a request to the provider to supply saved models.
	sess := &session{agentName: "claude-work", client: &claudeagent.Client{}, model: "glm-test"}
	list, err := sess.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	wantIDs := []string{"claude-test", "glm-test", "deepseek-test", "kimi-test", "gpt-test"}
	var ids []string
	for _, model := range list.Models {
		ids = append(ids, model.ID)
		if model.Name != model.ID || model.SupportEffort || len(model.Efforts) != 0 {
			t.Fatalf("saved model advertised unsupported metadata: %+v", model)
		}
	}
	if !reflect.DeepEqual(ids, wantIDs) || list.CurrentModelID != "glm-test" {
		t.Fatalf("model list = %+v, want IDs %v with glm-test selected", list, wantIDs)
	}

	// Native entries retain their names and capability metadata when the
	// provider also lists them; saved IDs only append missing rows.
	native := []types.ModelInfo{claudeModelInfo(claudeagent.ModelInfo{Value: "claude-test", DisplayName: "Native Claude", Description: "Native metadata"})}
	merged := providermodels.Supplement("claude-work", "anthropic-compatible", native)
	if len(merged) != len(wantIDs) || !reflect.DeepEqual(merged[0], native[0]) {
		t.Fatalf("native metadata or deduplication changed: %+v", merged)
	}

	// Changes made by a provider sync are visible on the next list request.
	write("api-providers.json", []any{map[string]any{"id": "auto-media", "protocols": []string{"anthropic-compatible"}, "models": []string{"glm-test", "new-model"}}})
	list, err = sess.ListModels(context.Background())
	if err != nil || len(list.Models) != 2 || list.Models[1].ID != "new-model" || list.CurrentModelID != "glm-test" {
		t.Fatalf("synced model list = %+v, error = %v", list, err)
	}

	write("preferences.json", claudeProviderSelection("backup-id", "backup"))
	list, err = sess.ListModels(context.Background())
	if err != nil || len(list.Models) != 0 || list.CurrentModelID != "" {
		t.Fatalf("provider models survived switching to a backup: %+v, error = %v", list, err)
	}
}

func TestClaudeProviderModelsRequireAnthropicProtocolAndBinding(t *testing.T) {
	for _, tc := range []struct {
		name      string
		protocols []string
		selection string
		wantExtra bool
	}{
		{"openai-only", []string{"openai-compatible"}, "provider", false},
		{"gemini-only", []string{"gemini-compatible"}, "provider", false},
		{"missing-protocols", nil, "provider", false},
		{"deleted-provider", []string{"anthropic-compatible"}, "deleted", false},
		{"anthropic", []string{"anthropic-compatible"}, "provider", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			write := claudeProviderModelFixture(t)
			write("preferences.json", claudeProviderSelection(tc.selection, "api_provider"))
			write("api-providers.json", []any{map[string]any{"id": "provider", "protocols": tc.protocols, "models": []string{"glm-test"}}})
			native := []types.ModelInfo{{ID: "native", Name: "Native"}}
			got := providermodels.Supplement("claude-work", "anthropic-compatible", native)
			want := append([]types.ModelInfo(nil), native...)
			if tc.wantExtra {
				want = append(want, types.ModelInfo{ID: "glm-test", Name: "glm-test"})
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("models = %+v, want %+v", got, want)
			}
		})
	}
}
