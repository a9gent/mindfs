package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/e2ee"
)

func TestParseClientContext(t *testing.T) {
	payload := map[string]any{
		"context": map[string]any{
			"current_root": "ignored-by-payload",
			"selection": map[string]any{
				"file_path":  "docs/readme.md",
				"start_line": 1,
				"end_line":   3,
				"text":       "abc",
			},
		},
	}

	got := parseClientContext(payload, "mindfs")
	if got.CurrentRoot != "ignored-by-payload" {
		t.Fatalf("unexpected current root: %q", got.CurrentRoot)
	}
	if got.Selection == nil || got.Selection.Text != "abc" {
		t.Fatalf("unexpected selection: %#v", got.Selection)
	}

	got = parseClientContext(map[string]any{}, "fallback-root")
	if got.CurrentRoot != "fallback-root" {
		t.Fatalf("expected fallback root, got %q", got.CurrentRoot)
	}
}

func TestSessionMessageContextHasNoDeadlineWithoutAppContext(t *testing.T) {
	handler := &WSHandler{}

	ctx, cancel := handler.sessionMessageContext()
	defer cancel()

	if _, ok := ctx.Deadline(); ok {
		t.Fatal("session message context unexpectedly has a deadline")
	}
}

func TestSessionMessageContextUsesAgentPoolLifecycle(t *testing.T) {
	pool := agent.NewPool(agent.Config{})
	defer pool.CloseAll()

	handler := &WSHandler{AppContext: &AppContext{Agents: pool}}
	ctx, cancel := handler.sessionMessageContext()
	defer cancel()

	if _, ok := ctx.Deadline(); ok {
		t.Fatal("session message context unexpectedly has a deadline")
	}
	pool.CloseAll()
	select {
	case <-ctx.Done():
	default:
		t.Fatal("expected session message context to be canceled when agent pool closes")
	}
}

func TestRequireWSProofAcceptsValidProof(t *testing.T) {
	clientID := "web-test"
	key := []byte("0123456789abcdef0123456789abcdef")
	manager := e2ee.NewManager(e2ee.Config{
		Enabled:       true,
		NodeID:        "node",
		PairingSecret: "secret",
	})
	if _, err := manager.OpenSessionForClient(clientID, e2ee.DerivedKey{Transport: key}); err != nil {
		t.Fatalf("OpenSessionForClient: %v", err)
	}
	handler := &WSHandler{AppContext: &AppContext{E2EE: manager}}
	ts := time.Now().UTC().Format(time.RFC3339)
	proofPath := "/ws?client_id=" + url.QueryEscape(clientID)
	proof := e2ee.BuildRequestProof(key, http.MethodGet, proofPath, ts, clientID)
	req := httptest.NewRequest(http.MethodGet, proofPath+"&"+wsTSQuery+"="+url.QueryEscape(ts)+"&"+wsProofQuery+"="+url.QueryEscape(proof), nil)

	if err := handler.requireWSProof(req, clientID); err != nil {
		t.Fatalf("requireWSProof() error = %v", err)
	}
}

func TestRequireWSProofRejectsMissingProofWhenE2EEEnabled(t *testing.T) {
	clientID := "web-test"
	manager := e2ee.NewManager(e2ee.Config{
		Enabled:       true,
		NodeID:        "node",
		PairingSecret: "secret",
	})
	handler := &WSHandler{AppContext: &AppContext{E2EE: manager}}
	req := httptest.NewRequest(http.MethodGet, "/ws?client_id="+url.QueryEscape(clientID), nil)

	if err := handler.requireWSProof(req, clientID); err == nil {
		t.Fatal("expected missing proof to be rejected")
	}
}

func TestWSProofPathExcludesProofQueryParams(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/ws?client_id=web-test&e2ee_ts=now&e2ee_proof=proof", nil)

	if got, want := wsProofPath(req), "/ws?client_id=web-test"; got != want {
		t.Fatalf("wsProofPath() = %q, want %q", got, want)
	}
}
