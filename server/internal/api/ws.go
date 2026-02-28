package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/api/usecase"
	ctxbuilder "mindfs/server/internal/context"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/session"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

const sessionMessageTimeout = 10 * time.Minute

// WSHandler manages JSON-RPC over WebSocket.
type WSHandler struct {
	AppContext *AppContext
	fileOnce   sync.Once
	proberOnce sync.Once
}

type StreamEvent struct {
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
}

// ServeHTTP upgrades the connection and processes JSON-RPC messages.
func (h *WSHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.fileOnce.Do(func() {
		if h.AppContext != nil {
			h.AppContext.AddFileChangeListener(h.broadcastFileChange)
		}
	})
	h.proberOnce.Do(func() {
		if h.AppContext != nil && h.AppContext.GetProber() != nil {
			h.AppContext.GetProber().AddListener(h.broadcastAgentStatusChange)
		}
	})
	clientID := strings.TrimSpace(r.URL.Query().Get("client_id"))
	if clientID == "" {
		http.Error(w, "client_id required", http.StatusBadRequest)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	if h.AppContext != nil {
		h.AppContext.GetSessionStreamHub().RegisterClient(clientID, conn)
	}
	defer func() {
		if h.AppContext != nil {
			h.AppContext.GetSessionStreamHub().UnregisterClient(clientID, conn)
		}
		conn.Close()
	}()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var req WSRequest
		if err := json.Unmarshal(message, &req); err != nil {
			h.sendWSError(conn, "", "invalid_request", "invalid request")
			continue
		}
		h.handleWSRequest(r.Context(), conn, clientID, req)
	}
}

func (h *WSHandler) broadcastFileChange(change fs.FileChangeEvent) {
	resp := WSResponse{
		Type: "file.changed",
		Payload: map[string]any{
			"root_id": change.RootID,
			"path":    change.Path,
			"op":      change.Op,
			"is_dir":  change.IsDir,
		},
	}
	h.broadcastWS(resp)
}

func (h *WSHandler) broadcastAgentStatusChange(status agent.Status) {
	resp := WSResponse{
		Type: "agent.status.changed",
		Payload: map[string]any{
			"name":       status.Name,
			"available":  status.Available,
			"version":    status.Version,
			"error":      status.Error,
			"last_probe": status.LastProbe,
		},
	}
	h.broadcastWS(resp)
}

func (h *WSHandler) broadcastWS(resp WSResponse) {
	if h.AppContext == nil {
		return
	}
	h.AppContext.GetSessionStreamHub().BroadcastAll(resp)
}

func (h *WSHandler) handleWSRequest(ctx context.Context, conn *websocket.Conn, clientID string, req WSRequest) {
	switch req.Type {
	case "session.message":
		h.handleSessionMessage(ctx, conn, clientID, req)
	default:
		h.sendWSError(conn, req.ID, "method_not_found", "method not found")
	}
}

func (h *WSHandler) handleSessionMessage(ctx context.Context, conn *websocket.Conn, clientID string, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	content := getString(req.Payload, "content")
	sessionType := getString(req.Payload, "type")
	agentName := getString(req.Payload, "agent")
	if content == "" || sessionType == "" || agentName == "" {
		h.sendWSError(conn, req.ID, "invalid_request", "content, type and agent required")
		return
	}

	uc := &usecase.Service{Registry: h.AppContext}
	if key == "" {
		sessionName := buildSessionNameFromMessage(content)
		created, err := uc.CreateSession(ctx, usecase.CreateSessionInput{
			RootID: rootID,
			Input: session.CreateInput{
				Type:  sessionType,
				Agent: agentName,
				Name:  sessionName,
			},
		})
		if err != nil {
			h.sendWSError(conn, req.ID, "session.create_failed", err.Error())
			return
		}
		key = created.Key
	}
	if h.AppContext != nil {
		h.AppContext.GetSessionStreamHub().BindSessionClient(key, clientID)
	}
	clientCtx := parseClientContext(req.Payload, rootID)
	streamHub := h.AppContext.GetSessionStreamHub()
	parentCtx := context.Background()
	if agentPool := h.AppContext.GetAgentPool(); agentPool != nil {
		parentCtx = agentPool.Context()
	}
	msgCtx, cancel := context.WithTimeout(parentCtx, sessionMessageTimeout)
	defer cancel()

	err := uc.SendMessage(msgCtx, usecase.SendMessageInput{
		RootID:    rootID,
		Key:       key,
		Agent:     agentName,
		Content:   content,
		ClientCtx: clientCtx,
		OnUpdate: func(update agenttypes.Event) {
			event := updateToEvent(update)
			if event == nil {
				return
			}
			streamHub.BroadcastSessionStream(key, event)
		},
	})
	if err != nil {
		errorMessage := normalizeAgentErrorMessage(err)
		event := &StreamEvent{
			Type: "error",
			Data: map[string]string{"message": errorMessage},
		}
		streamHub.BroadcastSessionStream(key, event)
	}

	streamHub.BroadcastSessionDone(key, req.ID)
}

func (h *WSHandler) sendWSError(conn *websocket.Conn, id, code, message string) {
	resp := WSResponse{
		ID:   id,
		Type: "session.error",
		Error: &WSResponseError{
			Code:    code,
			Message: message,
		},
		Payload: map[string]any{},
	}
	if h.AppContext != nil {
		h.AppContext.GetSessionStreamHub().WriteJSON(conn, resp)
		return
	}
	conn.WriteJSON(resp)
}

func updateToEvent(update agenttypes.Event) *StreamEvent {
	switch update.Type {
	case agenttypes.EventTypeMessageChunk:
		if chunk, ok := update.Data.(agenttypes.MessageChunk); ok {
			return &StreamEvent{Type: "message_chunk", Data: chunk}
		}
	case agenttypes.EventTypeThoughtChunk:
		if chunk, ok := update.Data.(agenttypes.ThoughtChunk); ok {
			return &StreamEvent{Type: "thought_chunk", Data: chunk}
		}
	case agenttypes.EventTypeToolCall:
		if tc, ok := update.Data.(agenttypes.ToolCall); ok {
			return &StreamEvent{Type: "tool_call", Data: tc}
		}
	case agenttypes.EventTypeToolUpdate:
		if tu, ok := update.Data.(agenttypes.ToolCall); ok {
			return &StreamEvent{Type: "tool_call_update", Data: tu}
		}
	case agenttypes.EventTypeMessageDone:
		return &StreamEvent{Type: "message_done"}
	}
	return nil
}

func normalizeAgentErrorMessage(err error) string {
	if err == nil {
		return "Unknown error"
	}
	raw := strings.TrimSpace(err.Error())
	if raw == "" {
		return "Unknown error"
	}
	var payload struct {
		Message string `json:"message"`
	}
	if strings.HasPrefix(raw, "{") && json.Unmarshal([]byte(raw), &payload) == nil && strings.TrimSpace(payload.Message) != "" {
		return strings.TrimSpace(payload.Message)
	}
	return raw
}

func buildSessionNameFromMessage(message string) string {
	oneLine := strings.Join(strings.Fields(strings.TrimSpace(message)), " ")
	if oneLine == "" {
		return ""
	}
	const max = 60
	runes := []rune(oneLine)
	if len(runes) <= max {
		return oneLine
	}
	return string(runes[:max]) + "..."
}

func getString(payload map[string]any, key string) string {
	if payload == nil {
		return ""
	}
	if value, ok := payload[key]; ok {
		if s, ok := value.(string); ok {
			return s
		}
	}
	return ""
}

func parseClientContext(payload map[string]any, rootID string) ctxbuilder.ClientContext {
	ctx := ctxbuilder.ClientContext{CurrentRoot: rootID}
	if payload == nil {
		return ctx
	}
	raw, ok := payload["context"]
	if !ok || raw == nil {
		return ctx
	}
	body, err := json.Marshal(raw)
	if err != nil {
		return ctx
	}
	if err := json.Unmarshal(body, &ctx); err != nil {
		return ctx
	}
	if ctx.CurrentRoot == "" {
		ctx.CurrentRoot = rootID
	}
	return ctx
}
