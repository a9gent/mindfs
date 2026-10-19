package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"

	"mindfs/server/internal/agent/types"
	"mindfs/server/internal/config"
	"mindfs/server/internal/testutil"

	codexsdk "github.com/fanwenlin/codex-go-sdk/codex"
	codextypes "github.com/fanwenlin/codex-go-sdk/types"
)

func providerModelFixture(t *testing.T) func(string, any) {
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

func providerSelection(id, kind string) map[string]any {
	return map[string]any{"last_config_selection": map[string]string{"type": kind, "id": id}}
}

func TestSupplementSavedProviderModelsPreservesNativeMetadataAndDoesNotFetch(t *testing.T) {
	write := providerModelFixture(t)
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	defer upstream.Close()
	write("preferences.json", map[string]any{"agents": map[string]any{
		"codex":       providerSelection("api-one", "api_provider"),
		"codex-other": providerSelection("api-two", "api_provider"),
	}})
	write("api-providers.json", []any{
		map[string]any{"id": "api-two", "baseUrl": upstream.URL, "apiKey": "fake-other", "models": []string{"other-account-model"}},
		map[string]any{"id": "api-one", "baseUrl": upstream.URL, "apiKey": "fake-key", "models": []string{" native ", " glm-test ", "", "glm-test", "qwen-test"}},
	})
	native := []types.ModelInfo{{ID: "native", Name: "Original name", Description: "Original metadata", Hidden: true, SupportEffort: true, Efforts: []string{"high"}}}
	got := supplementSavedProviderModels("codex", native)
	want := append(append([]types.ModelInfo{}, native...), types.ModelInfo{ID: "glm-test", Name: "glm-test"}, types.ModelInfo{ID: "qwen-test", Name: "qwen-test"})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("models = %+v, want %+v", got, want)
	}
	other := supplementSavedProviderModels("codex-other", nil)
	if len(other) != 1 || other[0].ID != "other-account-model" {
		t.Fatalf("wrong agent binding: %+v", other)
	}
	if requests.Load() != 0 {
		t.Fatalf("unexpected provider requests: %d", requests.Load())
	}
	if len(supplementSavedProviderModels("unbound", nil)) != 0 {
		t.Fatal("unbound agent received provider models")
	}
}

func TestSavedProviderModelsReflectSyncAndConfigSwitch(t *testing.T) {
	write := providerModelFixture(t)
	bind := func(id, kind string) {
		write("preferences.json", map[string]any{"agents": map[string]any{"codex": providerSelection(id, kind)}})
	}
	providers := func(models []string) {
		write("api-providers.json", []any{map[string]any{"id": "api-one", "models": models}, map[string]any{"id": "api-two", "models": []string{"second-model"}}})
	}
	check := func(want []types.ModelInfo) {
		t.Helper()
		if got := supplementSavedProviderModels("codex", nil); !reflect.DeepEqual(got, want) {
			t.Fatalf("models = %+v, want %+v", got, want)
		}
	}
	bind("api-one", "api_provider")
	providers([]string{"before-sync"})
	check([]types.ModelInfo{{ID: "before-sync", Name: "before-sync"}})
	providers([]string{"after-sync"})
	check([]types.ModelInfo{{ID: "after-sync", Name: "after-sync"}})
	bind("api-two", "api_provider")
	check([]types.ModelInfo{{ID: "second-model", Name: "second-model"}})
	bind("backup-id", "backup")
	check(nil)
	bind("deleted", "api_provider")
	check(nil)
}

func TestSavedProviderModelsMissingOrCorruptFilesKeepNativeList(t *testing.T) {
	for _, broken := range []string{"preferences.json", "api-providers.json"} {
		for _, missing := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/missing=%t", broken, missing), func(t *testing.T) {
				write := providerModelFixture(t)
				write("preferences.json", map[string]any{"agents": map[string]any{"codex": providerSelection("api-one", "api_provider")}})
				write("api-providers.json", []any{map[string]any{"id": "api-one", "models": []string{"extra"}}})
				dir, _ := config.MindFSConfigDir()
				path := filepath.Join(dir, broken)
				var err error
				if missing {
					err = os.Remove(path)
				} else {
					err = os.WriteFile(path, []byte("{"), 0o600)
				}
				if err != nil {
					t.Fatal(err)
				}
				native := []types.ModelInfo{{ID: "native", Name: "Original"}}
				if got := supplementSavedProviderModels("codex", native); !reflect.DeepEqual(got, native) {
					t.Fatalf("native list changed: %+v", got)
				}
			})
		}
	}
}

type providerModelsRPC struct{ closeSessionRPCExec }

func (e *providerModelsRPC) ListModels(ctx context.Context, params codextypes.ModelListParams) (*codextypes.ModelListResponse, error) {
	payload, err := e.RPCCall(ctx, "model/list", params)
	if err != nil {
		return nil, err
	}
	var response codextypes.ModelListResponse
	err = json.Unmarshal(payload, &response)
	return &response, err
}

func (e *providerModelsRPC) RPCCall(_ context.Context, method string, _ interface{}) (json.RawMessage, error) {
	switch method {
	case "model/list":
		return json.RawMessage(`{"data":[{"id":"native","model":"native","displayName":"Original name","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"high"}]}]}`), nil
	case "config/read":
		return json.RawMessage(`{"config":{"model":"glm-test"}}`), nil
	default:
		return nil, fmt.Errorf("unexpected RPC: %s", method)
	}
}

func TestSessionListModelsSupplementsBoundProvider(t *testing.T) {
	write := providerModelFixture(t)
	write("preferences.json", map[string]any{"agents": map[string]any{"codex": providerSelection("api-one", "api_provider")}})
	write("api-providers.json", []any{map[string]any{"id": "api-one", "models": []string{"native", "glm-test"}}})
	runtime := NewRuntime()
	runtime.clients["codex"] = codexsdk.NewCodexWithExec(&providerModelsRPC{}, codexsdk.CodexOptions{})
	sess, err := runtime.OpenSession(context.Background(), OpenOptions{AgentName: "codex", SessionKey: "test-session"})
	if err != nil {
		t.Fatal(err)
	}
	list, err := sess.(*session).ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if list.CurrentModelID != "glm-test" || len(list.Models) != 2 || list.Models[0].Name != "Original name" || !reflect.DeepEqual(list.Models[0].Efforts, []string{"high"}) || list.Models[1].ID != "glm-test" || list.Models[1].SupportEffort {
		t.Fatalf("model list = %+v", list)
	}
}
