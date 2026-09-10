package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"mindfs/server/internal/preferences"
)

func writeAPIProvidersFile(t *testing.T, providers []agentAPIProvider) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), ".config"))
	path, err := agentAPIProvidersPath()
	if err != nil {
		t.Fatalf("agentAPIProvidersPath: %v", err)
	}
	data, err := json.Marshal(providers)
	if err != nil {
		t.Fatalf("marshal providers: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write providers: %v", err)
	}
}

func TestTestAgentAPIProviderModelOpenAI(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "model-a" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": "OK"}}},
		})
	}))
	defer upstream.Close()

	writeAPIProvidersFile(t, []agentAPIProvider{
		{ID: "api-test", Name: "test", BaseURL: upstream.URL + "/v1", APIKey: "secret", Protocols: []string{apiProviderProtocolOpenAICompatible}, Models: []string{"model-a"}},
	})

	result, err := testAgentAPIProviderModel(context.Background(), agentAPIProviderTestRequest{ProviderID: "api-test"})
	if err != nil {
		t.Fatalf("testAgentAPIProviderModel: %v", err)
	}
	if !result.Success || result.Response != "OK" || result.Model != "model-a" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.LatencyMS < 0 {
		t.Fatalf("latency should be non-negative")
	}
	if result.Protocol != apiProviderProtocolOpenAICompatible {
		t.Fatalf("protocol: %s", result.Protocol)
	}

	if _, err := testAgentAPIProviderModel(context.Background(), agentAPIProviderTestRequest{ProviderID: "api-missing"}); err == nil {
		t.Fatalf("missing provider should fail")
	}
}

func TestSyncAllAgentAPIProvidersKeepsModelsOnFailure(t *testing.T) {
	var probeHits int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probeHits++
		if r.URL.Path == "/down/v1/models" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"id": "model-a"}, {"id": "model-b"}},
		})
	}))
	defer upstream.Close()

	writeAPIProvidersFile(t, []agentAPIProvider{
		{ID: "api-good", Name: "good", BaseURL: upstream.URL + "/ok", APIKey: "k1", Models: []string{"old"}, ModelFamilies: []string{"old"}},
		{ID: "api-bad", Name: "bad", BaseURL: upstream.URL + "/down", APIKey: "k2", Models: []string{"keep-me"}, ModelFamilies: []string{"fam"}},
	})

	providers, results, err := syncAllAgentAPIProviders(context.Background(), nil)
	if err != nil {
		t.Fatalf("syncAllAgentAPIProviders: %v", err)
	}
	if probeHits == 0 {
		t.Fatal("expected probes to run")
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	byID := map[string]agentAPIProviderSyncAllResult{}
	for _, result := range results {
		byID[result.ID] = result
	}
	if !byID["api-good"].Success || byID["api-good"].ModelCount != 2 {
		t.Fatalf("good provider result unexpected: %+v", byID["api-good"])
	}
	if byID["api-bad"].Success {
		t.Fatalf("bad provider should fail")
	}
	if byID["api-bad"].Error == "" {
		t.Fatalf("bad provider should record error")
	}
	byProvider := map[string]agentAPIProvider{}
	for _, provider := range providers {
		byProvider[provider.ID] = provider
	}
	got := byProvider["api-bad"].Models
	if len(got) != 1 || got[0] != "keep-me" {
		t.Fatalf("failed provider must keep old models, got %v", got)
	}
	if len(byProvider["api-good"].Models) != 2 {
		t.Fatalf("good provider models should update, got %v", byProvider["api-good"].Models)
	}
}

func TestAPIProviderTestURLHelpers(t *testing.T) {
	if got := openAIChatURL("https://api.example.com/v1"); got != "https://api.example.com/v1/chat/completions" {
		t.Fatalf("openAIChatURL: %s", got)
	}
	if got := anthropicMessagesURL("https://api.example.com"); got != "https://api.example.com/v1/messages" {
		t.Fatalf("anthropicMessagesURL: %s", got)
	}
	if got := anthropicMessagesURL("https://api.example.com/v1"); got != "https://api.example.com/v1/messages" {
		t.Fatalf("anthropicMessagesURL suffix: %s", got)
	}
	if got := geminiGenerateURL("https://api.example.com/v1beta", "m1"); got != "https://api.example.com/v1beta/models/m1:generateContent" {
		t.Fatalf("geminiGenerateURL: %s", got)
	}
}

func TestSyncAllAgentAPIProvidersReappliesToAgents(t *testing.T) {
	var mu sync.Mutex
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"id": "fresh-model-a"}, {"id": "fresh-model-b"}},
		})
	}))
	defer upstream.Close()

	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("USERPROFILE", tmpHome)
	writeAPIProvidersFile(t, []agentAPIProvider{
		{ID: "api-pi", Name: "9779", BaseURL: upstream.URL + "/v1", APIKey: "secret", Protocols: []string{apiProviderProtocolOpenAICompatible}, Models: []string{"stale"}},
	})

	// 预置偏好：pi 上次手动应用了供应商 api-pi，codex 关联的是其它供应商。
	store, err := preferences.NewStore()
	if err != nil {
		t.Fatalf("preferences.NewStore: %v", err)
	}
	if err := store.UpdateAgentLastConfigSelection("pi", preferences.LastConfigSelection{Type: "api_provider", ID: "api-pi", Name: "9779"}); err != nil {
		t.Fatalf("UpdateAgentLastConfigSelection(pi): %v", err)
	}
	if err := store.UpdateAgentLastConfigSelection("codex", preferences.LastConfigSelection{Type: "api_provider", ID: "api-other", Name: "other"}); err != nil {
		t.Fatalf("UpdateAgentLastConfigSelection(codex): %v", err)
	}

	providers, results, err := syncAllAgentAPIProviders(context.Background(), store)
	if err != nil {
		t.Fatalf("syncAllAgentAPIProviders: %v", err)
	}
	if len(results) != 1 || !results[0].Success {
		t.Fatalf("unexpected results: %+v", results)
	}
	if len(results[0].Applied) != 1 {
		t.Fatalf("expected only pi to be re-applied, got %+v", results[0].Applied)
	}
	applied := results[0].Applied[0]
	if applied.Agent != "pi" || !applied.Success {
		t.Fatalf("unexpected apply result: %+v", applied)
	}

	// pi 的 models.json 应写入最新模型列表。
	payload, err := os.ReadFile(filepath.Join(tmpHome, ".pi", "agent", "models.json"))
	if err != nil {
		t.Fatalf("read pi models.json: %v", err)
	}
	var piCfg struct {
		Providers map[string]struct {
			Models []struct {
				ID string `json:"id"`
			} `json:"models"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(payload, &piCfg); err != nil {
		t.Fatalf("unmarshal pi models.json: %v", err)
	}
	piProvider, ok := piCfg.Providers["9779"]
	if !ok {
		t.Fatalf("provider 9779 missing in pi models.json: %s", payload)
	}
	if len(piProvider.Models) != 2 || piProvider.Models[0].ID != "fresh-model-a" {
		t.Fatalf("pi models not updated, got %+v", piProvider.Models)
	}

	// codex 关联其它供应商，不应被写入（其配置文件不应被创建）。
	if _, err := os.Stat(filepath.Join(tmpHome, ".codex", "config.toml")); !os.IsNotExist(err) {
		t.Fatalf("codex config should not be touched, err=%v", err)
	}
	_ = providers
}

func TestTruncateAndSanitizeAPIProviderStrings(t *testing.T) {
	if got := truncateAPIProviderResponse("  hello  "); got != "hello" {
		t.Fatalf("truncate: %q", got)
	}
	long := make([]byte, 300)
	for i := range long {
		long[i] = 'a'
	}
	got := truncateAPIProviderResponse(string(long))
	if len(got) != 203 || got[200:] != "..." {
		t.Fatalf("truncate long: %q", got)
	}
	if sanitizeAPIProviderError("   ") != "unknown error" {
		t.Fatalf("sanitize empty")
	}
}
