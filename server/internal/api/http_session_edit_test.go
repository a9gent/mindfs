package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"mindfs/server/internal/agent"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/session"
)

func TestSessionEditReservationDrainsAndFreezesQueue(t *testing.T) {
	h := NewStreamHub(nil)
	h.reserveOrQueueSessionMessage("root", "chat", "Chat", QueuedUserMessage{ID: "original"})
	h.trackSessionJob("chat", 1)
	if !h.beginSessionEdit("chat") || h.beginSessionEdit("chat") {
		t.Fatal("edit reservation is not exclusive")
	}
	if h.sessionEditIdle("chat") {
		t.Fatal("active turn treated as drained")
	}
	_, queued := h.reserveOrQueueSessionMessage("root", "chat", "Chat", QueuedUserMessage{ID: "queued"})
	if !queued {
		t.Fatal("send bypassed edit reservation")
	}
	h.ClearSessionPending("chat")
	if h.sessionEditIdle("chat") {
		t.Fatal("job still has completion callbacks")
	}
	h.trackSessionJob("chat", -1)
	if !h.sessionEditIdle("chat") {
		t.Fatal("job did not drain")
	}
	if _, _, ok := h.PopQueuedSessionMessage("chat", "queued"); ok {
		t.Fatal("explicit queue send bypassed edit")
	}
	if _, ok := h.PromoteQueuedSessionMessage("chat", "queued"); ok {
		t.Fatal("promotion bypassed edit")
	}
	h.finishSessionEdit("chat", true)
	if h.sessionEditIdle("chat") {
		t.Fatal("replacement turn not reserved")
	}
	h.ClearSessionPending("chat")
	_, queue, frozen := h.queueSnapshot("chat")
	if len(queue) != 1 || !frozen {
		t.Fatalf("queue was lost or resumed: %+v %v", queue, frozen)
	}
	if _, _, ok := h.PopQueuedSessionMessage("chat", ""); ok {
		t.Fatal("queue resumed automatically")
	}
}

func TestFailedEditDoesNotReleaseActiveTurn(t *testing.T) {
	h := NewStreamHub(nil)
	h.SetPendingReply("root", "chat", "Chat")
	h.beginSessionEdit("chat")
	h.finishSessionEdit("chat", false)
	if h.sessionEditIdle("chat") {
		t.Fatal("timed-out edit released the original active turn")
	}
}

// Runs as an isolated ACP subprocess. No model requests or real files are used.
func TestEditACPProcess(t *testing.T) {
	if os.Getenv("MINDFS_EDIT_ACP_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	var pendingID any
	nextID := 0
	respond := func(id, result any) { _ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result}) }
	for scanner.Scan() {
		var req struct {
			ID     any             `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			continue
		}
		switch req.Method {
		case "initialize":
			respond(req.ID, map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{"loadSession": true}})
		case "session/new":
			nextID++
			respond(req.ID, map[string]any{"sessionId": fmt.Sprintf("fake-%d", nextID)})
		case "session/load":
			respond(req.ID, map[string]any{})
		case "session/prompt":
			if strings.Contains(string(req.Params), "wrong-message") {
				_ = os.WriteFile(os.Getenv("MINDFS_EDIT_PROMPT_READY"), []byte("ready"), 0600)
				pendingID = req.ID
				continue
			}
			var params struct {
				SessionID string `json:"sessionId"`
			}
			_ = json.Unmarshal(req.Params, &params)
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": params.SessionID, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "regenerated-answer"}}}})
			respond(req.ID, map[string]any{"stopReason": "end_turn"})
		case "session/cancel":
			if pendingID != nil {
				respond(pendingID, map[string]any{"stopReason": "cancelled"})
				pendingID = nil
			}
		default:
			if req.ID != nil {
				respond(req.ID, map[string]any{})
			}
		}
	}
	os.Exit(0)
}

func TestEditMessageWhileACPReplyIsRunning(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	registry := fs.NewRegistry(filepath.Join(t.TempDir(), "registry.json"))
	root, err := registry.Upsert(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	readyPath := filepath.Join(t.TempDir(), "prompt-ready")
	pool := agent.NewPool(agent.Config{Agents: []agent.Definition{{Name: "edit-test", Protocol: agent.ProtocolACP, Command: executable, Args: []string{"-test.run=^TestEditACPProcess$"}, Env: map[string]string{"MINDFS_EDIT_ACP_HELPER": "1", "MINDFS_EDIT_PROMPT_READY": readyPath}}}})
	defer pool.CloseAll()
	app := &AppContext{Dirs: registry, Agents: pool}
	m, err := app.GetSessionManager(root.ID)
	if err != nil {
		t.Fatal(err)
	}
	s, err := m.Create(context.Background(), session.CreateInput{Type: session.TypeChat, Agent: "edit-test"})
	if err != nil {
		t.Fatal(err)
	}
	hub := app.GetSessionStreamHub()
	ready := make(chan struct{}, 2)
	releaseClients := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		id := r.URL.Query().Get("client")
		hub.RegisterClient(id, conn)
		defer hub.UnregisterClient(id, conn)
		hub.BindSessionClient(s.Key, id)
		ready <- struct{}{}
		<-releaseClients
	}))
	defer server.Close()
	defer close(releaseClients)
	clients := make([]*websocket.Conn, 0, 2)
	for _, id := range []string{"editor", "other-device"} {
		conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"?client="+id, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		clients = append(clients, conn)
		<-ready
	}
	ws := &WSHandler{AppContext: app}
	stamp := time.Now().UTC()
	ws.submitSessionMessage(sessionMessageJob{RootID: root.ID, Key: s.Key, RequestID: "original", SessionType: session.TypeChat, User: PendingUserMessage{Agent: "edit-test", Content: "wrong-message", Timestamp: stamp}})
	wait := func(check func() bool) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for !check() {
			if time.Now().After(deadline) {
				t.Fatal("timed out waiting for edit test")
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	wait(func() bool { return hub.GetPendingUserExchange(s.Key) != nil })
	wait(func() bool { _, err := os.Stat(readyPath); return err == nil })
	body, _ := json.Marshal(map[string]any{"root_id": root.ID, "session_key": s.Key, "seq": 0, "content": "correct-message", "original_content": "wrong-message", "original_timestamp": stamp})
	w := httptest.NewRecorder()
	(&HTTPHandler{AppContext: app}).handleSessionEdit(w, httptest.NewRequest("POST", "/api/sessions/edit", strings.NewReader(string(body))))
	if w.Code != 202 {
		t.Fatalf("edit status=%d: %s", w.Code, w.Body.String())
	}
	wait(func() bool { return hub.sessionEditIdle(s.Key) })
	result, err := m.Get(context.Background(), s.Key, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result.Key != s.Key || result.HistoryRevision != 1 || len(result.Exchanges) != 2 || result.Exchanges[0].Content != "correct-message" || result.Exchanges[1].Content != "regenerated-answer" {
		t.Fatalf("unexpected edited session: %+v", result)
	}
	for _, client := range clients {
		_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
		truncated, newUser := false, false
		for {
			var event struct {
				Type    string         `json:"type"`
				Payload map[string]any `json:"payload"`
			}
			if err := client.ReadJSON(&event); err != nil {
				t.Fatal(err)
			}
			if event.Type == "session.truncated" {
				truncated = true
				if event.Payload["from_seq"] != float64(1) || event.Payload["previous_revision"] != float64(0) || event.Payload["history_revision"] != float64(1) || event.Payload["session"] != nil {
					t.Fatalf("unexpected truncation payload: %+v", event.Payload)
				}
			}
			if event.Type == "session.user_message" && truncated {
				newUser = true
			}
			if event.Type == "session.done" && truncated {
				if !newUser {
					t.Fatal("replacement user event missing after truncation")
				}
				break
			}
		}
	}
	// The old editor must not be able to overwrite the replacement.
	w = httptest.NewRecorder()
	(&HTTPHandler{AppContext: app}).handleSessionEdit(w, httptest.NewRequest("POST", "/api/sessions/edit", strings.NewReader(string(body))))
	if w.Code != 409 {
		t.Fatalf("stale edit accepted: %d", w.Code)
	}
}
