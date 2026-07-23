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
