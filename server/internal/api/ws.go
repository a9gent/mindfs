package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
	"mindfs/server/internal/agent"
	"mindfs/server/internal/api/usecase"
	ctxbuilder "mindfs/server/internal/context"
	"mindfs/server/internal/session"
)

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

// WSHandler manages JSON-RPC over WebSocket.
type WSHandler struct {
	AppContext *AppContext
	TaskQueue  *agent.TaskQueue
	connMu     sync.RWMutex
	conns      map[*websocket.Conn]bool
}

// InitTaskListener sets up the task update listener for broadcasting.
func (h *WSHandler) InitTaskListener() {
	if h.TaskQueue == nil {
		return
	}
	h.TaskQueue.AddListener(func(update agent.TaskUpdate) {
		h.broadcastTaskUpdate(update)
	})
}

// broadcastTaskUpdate sends task update to all connected clients.
func (h *WSHandler) broadcastTaskUpdate(update agent.TaskUpdate) {
	h.connMu.RLock()
	conns := make([]*websocket.Conn, 0, len(h.conns))
	for conn := range h.conns {
		conns = append(conns, conn)
	}
	h.connMu.RUnlock()

	resp := WSResponse{
		Type: "task.update",
		Payload: map[string]any{
			"task_id":  update.TaskID,
			"status":   string(update.Status),
			"progress": update.Progress,
			"message":  update.Message,
			"error":    update.Error,
		},
	}

	for _, conn := range conns {
		_ = conn.WriteJSON(resp)
	}
}

// addConn registers a connection for broadcasting.
func (h *WSHandler) addConn(conn *websocket.Conn) {
	h.connMu.Lock()
	if h.conns == nil {
		h.conns = make(map[*websocket.Conn]bool)
	}
	h.conns[conn] = true
	h.connMu.Unlock()
}

// removeConn unregisters a connection.
func (h *WSHandler) removeConn(conn *websocket.Conn) {
	h.connMu.Lock()
	delete(h.conns, conn)
	h.connMu.Unlock()
}

// ServeHTTP upgrades the connection and processes JSON-RPC messages.
func (h *WSHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	h.addConn(conn)
	defer func() {
		h.removeConn(conn)
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
		h.handleWSRequest(r.Context(), conn, req)
	}
}

func (h *WSHandler) handleWSRequest(ctx context.Context, conn *websocket.Conn, req WSRequest) {
	switch req.Type {
	case "session.create":
		h.handleSessionCreate(ctx, conn, req)
	case "session.message":
		h.handleSessionMessage(ctx, conn, req)
	case "session.resume":
		h.handleSessionResume(ctx, conn, req)
	case "session.close":
		h.handleSessionClose(ctx, conn, req)
	case "task.list":
		h.handleTaskList(ctx, conn, req)
	case "task.get":
		h.handleTaskGet(ctx, conn, req)
	default:
		h.sendWSError(conn, req.ID, "method_not_found", "method not found")
	}
}

func (h *WSHandler) handleSessionCreate(ctx context.Context, conn *websocket.Conn, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	input := session.CreateInput{
		Key:   getString(req.Payload, "key"),
		Type:  getString(req.Payload, "type"),
		Agent: getString(req.Payload, "agent"),
		Name:  getString(req.Payload, "name"),
	}
	uc := &usecase.Service{Registry: h.AppContext}
	created, err := uc.CreateSession(ctx, usecase.CreateSessionInput{
		RootID: rootID,
		Input:  input,
	})
	if err != nil {
		h.sendWSError(conn, req.ID, "session.create_failed", err.Error())
		return
	}

	h.sendWS(conn, WSResponse{
		ID:   req.ID,
		Type: "session.created",
		Payload: map[string]any{
			"session_key": created.Key,
			"name":        created.Name,
		},
	})
}

func (h *WSHandler) handleSessionMessage(ctx context.Context, conn *websocket.Conn, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	content := getString(req.Payload, "content")
	if key == "" || content == "" {
		h.sendWSError(conn, req.ID, "invalid_request", "session_key and content required")
		return
	}

	uc := &usecase.Service{Registry: h.AppContext}
	clientCtx := parseClientContext(req.Payload, rootID)
	err := uc.SendMessage(ctx, usecase.SendMessageInput{
		RootID:    rootID,
		Key:       key,
		Content:   content,
		ClientCtx: clientCtx,
		OnUpdate: func(update agent.Event) {
			chunk := updateToChunk(update)
			h.sendWS(conn, WSResponse{
				Type: "session.stream",
				Payload: map[string]any{
					"session_key": key,
					"chunk":       chunk,
				},
			})
		},
	})
	if err != nil {
		h.sendWSError(conn, req.ID, "agent.timeout", err.Error())
		return
	}

	h.sendWS(conn, WSResponse{
		ID:   req.ID,
		Type: "session.done",
		Payload: map[string]any{
			"session_key": key,
		},
	})
}

func (h *WSHandler) handleSessionResume(ctx context.Context, conn *websocket.Conn, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	if key == "" {
		h.sendWSError(conn, req.ID, "invalid_request", "session_key required")
		return
	}

	uc := &usecase.Service{Registry: h.AppContext}
	resumed, err := uc.ResumeSession(ctx, usecase.ResumeSessionInput{
		RootID: rootID,
		Key:    key,
	})
	if err != nil {
		h.sendWSError(conn, req.ID, "session.resume_failed", err.Error())
		return
	}

	h.sendWS(conn, WSResponse{
		ID:   req.ID,
		Type: "session.resumed",
		Payload: map[string]any{
			"session_key": resumed.Key,
			"status":      resumed.Status,
		},
	})
}

func (h *WSHandler) handleSessionClose(ctx context.Context, conn *websocket.Conn, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	if key == "" {
		h.sendWSError(conn, req.ID, "invalid_request", "session_key required")
		return
	}

	uc := &usecase.Service{Registry: h.AppContext}
	closed, err := uc.CloseSession(ctx, usecase.CloseSessionInput{
		RootID: rootID,
		Key:    key,
	})
	if err != nil {
		h.sendWSError(conn, req.ID, "session.not_found", err.Error())
		return
	}

	if agentPool := h.AppContext.GetAgentPool(); agentPool != nil {
		agentPool.Close(closed.Key)
	}

	h.sendWS(conn, WSResponse{
		ID:   req.ID,
		Type: "session.closed",
		Payload: map[string]any{
			"session_key": closed.Key,
			"summary":     closed.Summary,
		},
	})
}

func (h *WSHandler) sendWS(conn *websocket.Conn, resp WSResponse) {
	_ = conn.WriteJSON(resp)
}

func (h *WSHandler) sendWSError(conn *websocket.Conn, id, code, message string) {
	_ = conn.WriteJSON(WSResponse{
		ID:   id,
		Type: "session.error",
		Error: &WSResponseError{
			Code:    code,
			Message: message,
		},
		Payload: map[string]any{},
	})
}

// updateToChunk converts an agent Event to a legacy StreamChunk.
func updateToChunk(update agent.Event) agent.StreamChunk {
	switch update.Type {
	case agent.EventTypeMessageChunk:
		if chunk, ok := update.Data.(agent.MessageChunk); ok {
			return agent.StreamChunk{Type: "text", Content: chunk.Content}
		}
	case agent.EventTypeThoughtChunk:
		if chunk, ok := update.Data.(agent.ThoughtChunk); ok {
			return agent.StreamChunk{Type: "thinking", Content: chunk.Content}
		}
	case agent.EventTypeToolCall:
		if tc, ok := update.Data.(agent.ToolCall); ok {
			return agent.StreamChunk{Type: "tool_call", Tool: tc.Name}
		}
	case agent.EventTypeToolUpdate:
		if tu, ok := update.Data.(agent.ToolCallUpdate); ok {
			return agent.StreamChunk{Type: "tool_result", Content: tu.Result}
		}
	case agent.EventTypeMessageDone:
		return agent.StreamChunk{Type: "done"}
	}
	return agent.StreamChunk{}
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

func (h *WSHandler) handleTaskList(ctx context.Context, conn *websocket.Conn, req WSRequest) {
	if h.TaskQueue == nil {
		h.sendWS(conn, WSResponse{
			ID:   req.ID,
			Type: "task.list",
			Payload: map[string]any{
				"tasks": []any{},
			},
		})
		return
	}

	sessionKey := getString(req.Payload, "session_key")
	var tasks []*agent.Task
	if sessionKey != "" {
		tasks = h.TaskQueue.ListBySession(sessionKey)
	} else {
		tasks = h.TaskQueue.List()
	}

	taskList := make([]map[string]any, 0, len(tasks))
	for _, t := range tasks {
		taskList = append(taskList, taskToMap(t))
	}

	h.sendWS(conn, WSResponse{
		ID:   req.ID,
		Type: "task.list",
		Payload: map[string]any{
			"tasks": taskList,
		},
	})
}

func (h *WSHandler) handleTaskGet(ctx context.Context, conn *websocket.Conn, req WSRequest) {
	if h.TaskQueue == nil {
		h.sendWSError(conn, req.ID, "task.not_found", "task queue not configured")
		return
	}

	taskID := getString(req.Payload, "task_id")
	if taskID == "" {
		h.sendWSError(conn, req.ID, "invalid_request", "task_id required")
		return
	}

	task := h.TaskQueue.Get(taskID)
	if task == nil {
		h.sendWSError(conn, req.ID, "task.not_found", "task not found")
		return
	}

	h.sendWS(conn, WSResponse{
		ID:   req.ID,
		Type: "task.get",
		Payload: map[string]any{
			"task": taskToMap(task),
		},
	})
}

func taskToMap(t *agent.Task) map[string]any {
	m := map[string]any{
		"id":          t.ID,
		"session_key": t.SessionKey,
		"type":        t.Type,
		"status":      string(t.Status),
		"progress":    t.Progress,
		"created_at":  t.CreatedAt,
	}
	if t.Message != "" {
		m["message"] = t.Message
	}
	if t.Error != "" {
		m["error"] = t.Error
	}
	if t.StartedAt != nil {
		m["started_at"] = *t.StartedAt
	}
	if t.CompletedAt != nil {
		m["completed_at"] = *t.CompletedAt
	}
	if len(t.Metadata) > 0 {
		m["metadata"] = t.Metadata
	}
	return m
}
