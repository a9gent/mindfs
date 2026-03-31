package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/api/usecase"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/session"
	"mindfs/server/internal/update"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

// WSHandler manages JSON-RPC over WebSocket.
type WSHandler struct {
	AppContext *AppContext
	fileOnce   sync.Once
	proberOnce sync.Once
	updateOnce sync.Once
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
	h.updateOnce.Do(func() {
		if h.AppContext != nil && h.AppContext.GetUpdateService() != nil {
			h.AppContext.GetUpdateService().AddListener(h.broadcastAppUpdate)
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
		h.pushInitialAppUpdate(clientID)
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
			"name":             status.Name,
			"installed":        status.Installed,
			"available":        status.Available,
			"version":          status.Version,
			"error":            status.Error,
			"last_probe":       status.LastProbe,
			"current_model_id": status.CurrentModelID,
			"models":           status.Models,
			"models_error":     status.ModelsError,
			"commands":         status.Commands,
			"commands_error":   status.CommandsError,
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

func (h *WSHandler) broadcastAppUpdate(status update.Status) {
	resp := WSResponse{
		Type:    "app.update",
		Payload: map[string]any{"state": status},
	}
	h.broadcastWS(resp)
}

func (h *WSHandler) pushInitialAppUpdate(clientID string) {
	if h.AppContext == nil || h.AppContext.GetUpdateService() == nil {
		return
	}
	h.AppContext.GetSessionStreamHub().SendToClient(clientID, WSResponse{
		Type:    "app.update",
		Payload: map[string]any{"state": h.AppContext.GetUpdateService().GetStatus()},
	})
}

func (h *WSHandler) handleWSRequest(ctx context.Context, conn *websocket.Conn, clientID string, req WSRequest) {
	switch req.Type {
	case "session.message":
		go h.handleSessionMessage(ctx, conn, clientID, req)
	case "session.ready":
		go h.handleSessionReady(clientID, req)
	case "session.cancel":
		h.handleSessionCancel(ctx, conn, clientID, req)
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
	model := getString(req.Payload, "model")
	if content == "" || sessionType == "" || agentName == "" {
		h.sendWSError(conn, req.ID, "invalid_request", "content, type and agent required")
		return
	}

	uc := &usecase.Service{Registry: h.AppContext}
	sessionName := ""
	if key == "" {
		sessionName = usecase.BuildFallbackSessionName(content)
		created, err := uc.CreateSession(ctx, usecase.CreateSessionInput{
			RootID: rootID,
			Input: session.CreateInput{
				Type:  sessionType,
				Agent: agentName,
				Model: model,
				Name:  sessionName,
			},
		})
		if err != nil {
			h.sendWSError(conn, req.ID, "session.create_failed", err.Error())
			return
		}
		key = created.Key
		go func(rootID, sessionKey, agentName, firstMessage string) {
			updated, err := uc.SuggestSessionName(context.Background(), usecase.SuggestSessionNameInput{
				RootID:       rootID,
				SessionKey:   sessionKey,
				Agent:        agentName,
				FirstMessage: firstMessage,
			})
			if err != nil {
				log.Printf("[session-name] async.error root=%s session=%s agent=%s err=%v", rootID, sessionKey, agentName, err)
				return
			}
			if updated == nil {
				return
			}
			if h.AppContext == nil {
				return
			}
			log.Printf("[session-name] async.broadcast root=%s session=%s name=%q", rootID, sessionKey, updated.Name)
			h.AppContext.GetSessionStreamHub().BroadcastSessionMetaUpdated(rootID, updated)
		}(rootID, key, agentName, content)
	}
	if h.AppContext != nil {
		h.AppContext.GetSessionStreamHub().BindSessionClient(key, clientID)
	}
	clientCtx := parseClientContext(req.Payload, rootID)
	streamHub := h.AppContext.GetSessionStreamHub()
	msgCtx, cancel := h.sessionMessageContext()
	defer cancel()

	err := uc.SendMessage(msgCtx, usecase.SendMessageInput{
		RootID:    rootID,
		Key:       key,
		Agent:     agentName,
		Model:     model,
		Content:   content,
		ClientCtx: clientCtx,
		OnStart: func() {
			streamHub.BroadcastSessionUserMessage(rootID, key, sessionType, sessionName, agentName, model, content, clientID)
		},
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
	streamHub.ClearSessionPending(key)

	log.Printf("[ws] session.done root=%s session=%s request=%s", rootID, key, req.ID)
	streamHub.BroadcastSessionDone(key, req.ID)
}

func (h *WSHandler) handleSessionReady(clientID string, req WSRequest) {
	if h.AppContext == nil {
		return
	}
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	if rootID == "" || key == "" {
		return
	}
	streamHub := h.AppContext.GetSessionStreamHub()
	streamHub.BindSessionClient(key, clientID)
	streamHub.ReplayPending(clientID, key)
}

func (h *WSHandler) sessionMessageContext() (context.Context, context.CancelFunc) {
	parentCtx := context.Background()
	if h != nil && h.AppContext != nil {
		if agentPool := h.AppContext.GetAgentPool(); agentPool != nil {
			parentCtx = agentPool.Context()
		}
	}
	return context.WithCancel(parentCtx)
}

func (h *WSHandler) handleSessionCancel(ctx context.Context, conn *websocket.Conn, _ string, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	if rootID == "" || key == "" {
		h.sendWSError(conn, req.ID, "invalid_request", "root_id and session_key required")
		return
	}
	log.Printf("[ws] session.cancel root=%s session=%s request=%s", rootID, key, req.ID)

	uc := &usecase.Service{Registry: h.AppContext}
	if err := uc.CancelSessionTurn(ctx, usecase.CancelSessionTurnInput{
		RootID: rootID,
		Key:    key,
	}); err != nil {
		h.sendWSError(conn, req.ID, "session.cancel_failed", err.Error())
	}
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

func parseClientContext(payload map[string]any, rootID string) usecase.ClientContext {
	ctx := usecase.ClientContext{CurrentRoot: rootID}
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
