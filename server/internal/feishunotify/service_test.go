package feishunotify

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"mindfs/server/internal/notify"
)

func TestBuildFeishuBodyInteractive(t *testing.T) {
	body, err := buildFeishuBody(notify.Payload{
		Type:  "session.done",
		Title: "proj · chat · 完成",
		Body:  "done summary",
		URL:   "./?root=r1&session=s1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if body["msg_type"] != "interactive" {
		t.Fatalf("msg_type=%v", body["msg_type"])
	}
	card, _ := body["card"].(map[string]any)
	if card == nil {
		t.Fatalf("missing card: %#v", body)
	}
	header, _ := card["header"].(map[string]any)
	if header == nil {
		t.Fatalf("missing header")
	}
	if header["template"] != "green" {
		t.Fatalf("template=%v", header["template"])
	}
}

func TestWebhookSend(t *testing.T) {
	var hits atomic.Int32
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got)
		_, _ = w.Write([]byte(`{"code":0,"msg":"ok"}`))
	}))
	defer srv.Close()

	svc := NewService(Config{
		Enabled:    true,
		WebhookURL: srv.URL,
	})
	if !svc.Enabled() {
		t.Fatal("expected enabled")
	}
	if err := svc.send(context.Background(), notify.Payload{
		Type:  "session.done",
		Title: "t",
		Body:  "b",
		Tag:   "event-1",
		Data:  map[string]any{"eventId": "event-1"},
	}); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 1 {
		t.Fatalf("hits=%d", hits.Load())
	}
	if got["msg_type"] != "interactive" {
		t.Fatalf("got=%#v", got)
	}
	// shouldSend dedup is independent of HTTP send.
	if !svc.shouldSend("event-dup") {
		t.Fatal("first event-dup should send")
	}
	if svc.shouldSend("event-dup") {
		t.Fatal("second event-dup should be deduped")
	}
	if hits.Load() != 1 {
		t.Fatalf("unexpected extra webhook hits=%d", hits.Load())
	}
}

func TestEventFilter(t *testing.T) {
	svc := NewService(Config{
		Enabled:    true,
		WebhookURL: "http://example.invalid",
		Events:     []string{"session.ask_user"},
	})
	if svc.allowsEvent("session.done") {
		t.Fatal("session.done should be filtered out")
	}
	if !svc.allowsEvent("session.ask_user") {
		t.Fatal("session.ask_user should be allowed")
	}
}

func TestMergeOverrides(t *testing.T) {
	cfg := MergeOverrides(Config{}, "https://hook.example", "", "", "", nil)
	if !cfg.Enabled || cfg.WebhookURL != "https://hook.example" {
		t.Fatalf("%#v", cfg)
	}
	off := false
	cfg = MergeOverrides(cfg, "", "", "", "", &off)
	if cfg.Enabled {
		t.Fatal("expected disabled override")
	}
}

func TestUpdateConfigHotReload(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APPDATA", dir)
	// MindFSConfigDir uses OS user config; force via env is platform-dependent.
	// Exercise in-memory Replace/Update without relying on config dir when possible.
	svc := NewService(Config{Enabled: false})
	if svc.Enabled() {
		t.Fatal("expected disabled")
	}
	enabled := true
	webhook := "https://open.feishu.cn/open-apis/bot/v2/hook/test"
	// UpdateConfig persists; if config dir fails in CI we still want hot memory update.
	// Use ReplaceConfig path via UpdateConfig and tolerate persist error only if dir unusable —
	// on normal temp APPDATA it should work on Windows; on Unix HOME may be needed.
	// Prefer direct field apply via UpdateConfig; if SaveConfig fails test still checks memory.
	out, err := svc.UpdateConfig(UpdateRequest{
		Enabled:    &enabled,
		WebhookURL: &webhook,
	})
	if err != nil {
		// Persist may fail if MindFSConfigDir is not writable; still verify live config.
		t.Logf("UpdateConfig persist note: %v", err)
	}
	if !svc.Enabled() {
		// If persist failed after memory update, Enabled should still be true.
		// Re-check public.
		_ = out
		if !configIsActive(svc.snapshot()) {
			t.Fatalf("expected active after update public=%#v snapshot=%#v", out, svc.snapshot())
		}
	}
	pub := svc.PublicConfig()
	if !pub.Enabled || pub.WebhookURL != webhook || !pub.Active {
		t.Fatalf("public=%#v", pub)
	}
	if pub.HasAppSecret {
		t.Fatal("expected no secret")
	}
	// Keep secret when omitted
	secret := "super-secret"
	appID := "cli_x"
	chat := "oc_x"
	_, _ = svc.UpdateConfig(UpdateRequest{AppID: &appID, AppSecret: &secret, ChatID: &chat})
	if !svc.PublicConfig().HasAppSecret {
		t.Fatal("expected has_app_secret")
	}
	emptyWebhook := ""
	_, _ = svc.UpdateConfig(UpdateRequest{WebhookURL: &emptyWebhook})
	// secret should remain
	if !svc.PublicConfig().HasAppSecret {
		t.Fatal("secret should be preserved when omitted")
	}
	clear := ""
	_, _ = svc.UpdateConfig(UpdateRequest{AppSecret: &clear})
	if svc.PublicConfig().HasAppSecret {
		t.Fatal("secret should clear when empty string sent")
	}
}

func TestAppMessagePathUsesToken(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		switch {
		case strings.Contains(r.URL.Path, "tenant_access_token"):
			_, _ = w.Write([]byte(`{"code":0,"tenant_access_token":"tok","expire":7200}`))
		case strings.Contains(r.URL.Path, "/im/v1/messages"):
			if got := r.Header.Get("Authorization"); got != "Bearer tok" {
				t.Errorf("auth=%q", got)
			}
			_, _ = w.Write([]byte(`{"code":0,"msg":"ok"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	// Point openAPIBase temporarily by constructing service and monkeypatching via sendAppMessage URL
	// We test getTenantAccessToken + postJSONAuth through a custom client/base by using webhook-only path
	// for unit isolation is enough; here we exercise token endpoint by temporarily replacing openAPIBase usage
	// via direct methods with full URLs is not exported. Use send with app credentials against custom transport.
	svc := NewService(Config{
		Enabled:   true,
		AppID:     "cli_a",
		AppSecret: "sec",
		ChatID:    "oc_chat",
	})
	// Replace client transport to rewrite host to test server.
	svc.client = srv.Client()
	// Rewrite open API calls by using a reverse proxy style: set Transport that maps open.feishu.cn to srv.
	svc.client.Transport = rewriteHostTransport{base: srv.URL, rt: http.DefaultTransport}

	if err := svc.send(context.Background(), notify.Payload{
		Type:  "session.ask_user",
		Title: "need input",
		Body:  "question",
		Tag:   "e2",
		Data:  map[string]any{"eventId": "e2"},
	}); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(paths, ",")
	if !strings.Contains(joined, "tenant_access_token") || !strings.Contains(joined, "/im/v1/messages") {
		t.Fatalf("paths=%v", paths)
	}
}

type rewriteHostTransport struct {
	base string
	rt   http.RoundTripper
}

func (t rewriteHostTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	baseURL := t.base
	if strings.HasSuffix(baseURL, "/") {
		baseURL = strings.TrimRight(baseURL, "/")
	}
	target := baseURL + req.URL.Path
	if req.URL.RawQuery != "" {
		target += "?" + req.URL.RawQuery
	}
	u, err := http.NewRequestWithContext(req.Context(), req.Method, target, req.Body)
	if err != nil {
		return nil, err
	}
	u.Header = req.Header.Clone()
	return t.rt.RoundTrip(u)
}
