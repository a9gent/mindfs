package api

import (
	"context"
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

func TestTurnUpdateTrackerWaitIdleWaitsForSettleWindow(t *testing.T) {
	tracker := newTurnUpdateTracker()
	tracker.Begin()
	done := make(chan bool, 1)
	go func() {
		done <- tracker.WaitIdle(context.Background(), 30*time.Millisecond, 500*time.Millisecond)
	}()

	select {
	case <-done:
		t.Fatal("WaitIdle returned while update was in-flight")
	case <-time.After(20 * time.Millisecond):
	}

	tracker.End()
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("WaitIdle returned false after update finished")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("WaitIdle did not return after settle window")
	}
}

func TestTurnUpdateTrackerWaitIdleTimesOutWhenUpdateNeverEnds(t *testing.T) {
	tracker := newTurnUpdateTracker()
	tracker.Begin()

	if tracker.WaitIdle(context.Background(), 10*time.Millisecond, 30*time.Millisecond) {
		t.Fatal("expected WaitIdle to time out while update remains in-flight")
	}
}

func TestStreamHubFrozenQueueBlocksAutomaticPopUntilUnfrozen(t *testing.T) {
	hub := NewStreamHub(nil)
	rootID := "root"
	sessionKey := "session"

	hub.EnqueueSessionMessage(rootID, sessionKey, "Session", QueuedUserMessage{
		ID: "first",
		PendingUserMessage: PendingUserMessage{
			Content:   "first message",
			Timestamp: time.Now().UTC(),
		},
	})
	hub.EnqueueSessionMessage(rootID, sessionKey, "Session", QueuedUserMessage{
		ID: "second",
		PendingUserMessage: PendingUserMessage{
			Content:   "second message",
			Timestamp: time.Now().UTC(),
		},
	})

	frozenQueue, frozen := hub.FreezeQueuedSessionMessages(sessionKey)
	if !frozen {
		t.Fatal("expected queue freeze to succeed")
	}
	if len(frozenQueue) != 2 {
		t.Fatalf("expected frozen queue snapshot to contain 2 items, got %d", len(frozenQueue))
	}
	if _, queue, ok := hub.PopQueuedSessionMessage(sessionKey, ""); ok {
		t.Fatal("expected frozen queue to block automatic pop")
	} else if len(queue) != 2 {
		t.Fatalf("expected frozen queue to remain intact, got %d items", len(queue))
	}

	queue, ok := hub.PromoteQueuedSessionMessage(sessionKey, "second")
	if !ok {
		t.Fatal("expected promote to succeed")
	}
	if len(queue) != 2 || queue[0].ID != "second" {
		t.Fatalf("expected promoted item at queue head, got %#v", queue)
	}

	item, queue, ok := hub.PopQueuedSessionMessage(sessionKey, "")
	if !ok {
		t.Fatal("expected promoted queue to be unfrozen")
	}
	if item.ID != "second" {
		t.Fatalf("expected promoted item to pop first, got %q", item.ID)
	}
	if len(queue) != 1 || queue[0].ID != "first" {
		t.Fatalf("expected remaining queue to contain first item, got %#v", queue)
	}
}

func TestStreamHubUnfreezeQueueAllowsAutomaticPop(t *testing.T) {
	hub := NewStreamHub(nil)
	sessionKey := "session"
	hub.EnqueueSessionMessage("root", sessionKey, "Session", QueuedUserMessage{
		ID: "first",
		PendingUserMessage: PendingUserMessage{
			Content:   "first message",
			Timestamp: time.Now().UTC(),
		},
	})
	_, frozen := hub.FreezeQueuedSessionMessages(sessionKey)
	if !frozen {
		t.Fatal("expected queue freeze to succeed")
	}

	unfrozenQueue, changed := hub.UnfreezeQueuedSessionMessages(sessionKey)
	if !changed {
		t.Fatal("expected queue unfreeze to report changed")
	}
	if len(unfrozenQueue) != 1 {
		t.Fatalf("expected unfreeze queue snapshot to contain 1 item, got %d", len(unfrozenQueue))
	}
	item, queue, ok := hub.PopQueuedSessionMessage(sessionKey, "")
	if !ok {
		t.Fatal("expected automatic pop after unfreeze")
	}
	if item.ID != "first" {
		t.Fatalf("expected first item, got %q", item.ID)
	}
	if len(queue) != 0 {
		t.Fatalf("expected empty queue, got %#v", queue)
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
