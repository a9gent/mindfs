package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"mindfs/server/internal/agent"

	"github.com/go-chi/chi/v5"
)

// agentMetadataPatchTestEnv points MINDFS_AGENTS_CONFIG at a temp agents.json
// holding one built-in-layer agent, so PATCH materialization can be asserted
// without touching the developer's real config.
func agentMetadataPatchTestEnv(t *testing.T, seed string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agents.json")
	if err := os.WriteFile(path, []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MINDFS_AGENTS_CONFIG", path)
	return path
}

func agentMetadataPatchBody(t *testing.T, handler *HTTPHandler, name, body string) *httptest.ResponseRecorder {
	t.Helper()
	router := http.NewServeMux()
	// chi.URLParam 需要真实路由上下文，直接挂一条 PATCH 路由再发请求。
	chiRouter := newMetadataTestRouter(handler)
	req := httptest.NewRequest(http.MethodPatch, "/api/agents/"+name+"/metadata", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	chiRouter.ServeHTTP(rec, req)
	_ = router
	return rec
}

func newMetadataTestRouter(handler *HTTPHandler) chi.Router {
	router := chi.NewRouter()
	router.Patch("/api/agents/{name}/metadata", handler.handleAgentMetadataPatch)
	return router
}

func TestAgentMetadataPatchMaterializesFullDefinition(t *testing.T) {
	// Minimal built-in agent: command must survive a label-only patch.
	seed := `{"agents":[{"name":"codex","command":"codex","protocol":"codex-sdk","args":["app-server"]}]}`
	path := agentMetadataPatchTestEnv(t, seed)

	app := &AppContext{}
	app.Prober = agent.NewProber(&agent.Config{Agents: []agent.Definition{{Name: "codex", Command: "codex"}}}, nil, 0)
	handler := &HTTPHandler{AppContext: app}

	rec := agentMetadataPatchBody(t, handler, "codex", `{"label":"CodeX","url":"https://example.test/console"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}

	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cfg agent.Config
	if err := json.Unmarshal(payload, &cfg); err != nil {
		t.Fatal(err)
	}
	// 物化写回 = 完整合并定义（含内置层 agent），按名查找 codex 校验字段完整
	var def *agent.Definition
	for i := range cfg.Agents {
		if cfg.Agents[i].Name == "codex" {
			def = &cfg.Agents[i]
			break
		}
	}
	if def == nil {
		t.Fatalf("codex missing from written config (%d agents)", len(cfg.Agents))
	}
	if def.Label != "CodeX" || def.URL != "https://example.test/console" {
		t.Fatalf("label/url = %q/%q", def.Label, def.URL)
	}
	if def.Command != "codex" || len(def.Args) != 1 || def.Args[0] != "app-server" {
		t.Fatalf("definition lost non-metadata fields: %+v", *def)
	}

	status, ok := app.Prober.GetStatus("codex")
	if !ok || status.Label != "CodeX" || status.URL != "https://example.test/console" {
		t.Fatalf("prober status not refreshed: %+v ok=%v", status, ok)
	}
}

func TestAgentMetadataPatchRejectsUnknownAgentAndBadURL(t *testing.T) {
	seed := `{"agents":[{"name":"codex","command":"codex"}]}`
	path := agentMetadataPatchTestEnv(t, seed)
	app := &AppContext{}
	app.Prober = agent.NewProber(nil, nil, 0)
	handler := &HTTPHandler{AppContext: app}

	if rec := agentMetadataPatchBody(t, handler, "ghost", `{"label":"x"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown agent status = %d, want 404", rec.Code)
	}
	if rec := agentMetadataPatchBody(t, handler, "codex", `{"url":"ftp://x"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad url status = %d, want 400", rec.Code)
	}
	if rec := agentMetadataPatchBody(t, handler, "codex", `{}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty patch status = %d, want 400", rec.Code)
	}
	// 白名单之外的字段不允许触碰 command
	if rec := agentMetadataPatchBody(t, handler, "codex", `{"label":"ok","command":"evil"}`); rec.Code != http.StatusOK {
		t.Fatalf("label patch status = %d", rec.Code)
	}
	payload, _ := os.ReadFile(path)
	if bytes.Contains(payload, []byte("evil")) {
		t.Fatalf("non-whitelisted field was written")
	}
}

func TestAgentMetadataPatchClearsFieldsWithEmptyString(t *testing.T) {
	seed := `{"agents":[{"name":"zcode-1","command":"zcode-acp-bridge","label":"Z2","url":"https://a.test"}]}`
	path := agentMetadataPatchTestEnv(t, seed)
	app := &AppContext{}
	app.Prober = agent.NewProber(nil, nil, 0)
	handler := &HTTPHandler{AppContext: app}

	if rec := agentMetadataPatchBody(t, handler, "zcode-1", `{"label":"","url":""}`); rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	payload, _ := os.ReadFile(path)
	var cfg agent.Config
	if err := json.Unmarshal(payload, &cfg); err != nil {
		t.Fatal(err)
	}
	// 物化写回包含全部合并后的 agent，按名查找
	var def *agent.Definition
	for i := range cfg.Agents {
		if cfg.Agents[i].Name == "zcode-1" {
			def = &cfg.Agents[i]
			break
		}
	}
	if def == nil {
		t.Fatalf("zcode-1 missing from written config")
	}
	if def.Label != "" || def.URL != "" {
		t.Fatalf("clear failed: %+v", *def)
	}
	if def.Command != "zcode-acp-bridge" {
		t.Fatalf("command lost on clear")
	}
}

func TestMergeAgentDefinitionInheritsMetadataFields(t *testing.T) {
	// 用户层条目是整定义替换（Command 等核心字段以 override 为准，现状语义）；
	// 新增的 metadata/协议声明字段允许缺省时从 base 继承。
	base := agent.Definition{
		Name:                 "zcode-2",
		Command:              "bridge",
		Protocol:             agent.ProtocolACP,
		APIProviderProtocols: []string{"anthropic-compatible"},
	}
	merged := agent.MergeHostedConfig(
		agent.Config{Agents: []agent.Definition{base}},
		agent.Config{Agents: []agent.Definition{{Name: "zcode-2", Command: "user-bridge"}}},
	)
	def, ok := merged.GetAgent("zcode-2")
	if !ok {
		t.Fatal("agent missing after merge")
	}
	if len(def.APIProviderProtocols) != 1 || def.APIProviderProtocols[0] != "anthropic-compatible" {
		t.Fatalf("apiProviderProtocols not inherited: %v", def.APIProviderProtocols)
	}
	if def.Command != "user-bridge" {
		t.Fatalf("override semantics changed: %+v", def)
	}
	// 用户层显式覆盖时以用户层为准（别名归一化发生在 agentSupportedAPIProtocols 读取时）
	override := agent.MergeHostedConfig(
		agent.Config{Agents: []agent.Definition{base}},
		agent.Config{Agents: []agent.Definition{{Name: "zcode-2", Command: "user-bridge", APIProviderProtocols: []string{"openai"}, Label: "L"}}},
	)
	def, _ = override.GetAgent("zcode-2")
	if len(def.APIProviderProtocols) != 1 || def.APIProviderProtocols[0] != "openai" || def.Label != "L" {
		t.Fatalf("override lost: %v %q", def.APIProviderProtocols, def.Label)
	}
	if got := normalizeAPIProviderProtocolList([]string{"OpenAI", " anthropic ", "openai", "gemini"}); len(got) != 3 || got[0] != "openai-compatible" || got[1] != "anthropic-compatible" || got[2] != "gemini-compatible" {
		t.Fatalf("normalizeAPIProviderProtocolList = %v", got)
	}
}
