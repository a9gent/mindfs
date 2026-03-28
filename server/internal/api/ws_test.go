package api

import (
	"testing"

	"mindfs/server/internal/agent"
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
