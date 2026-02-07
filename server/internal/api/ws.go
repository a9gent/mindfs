package api

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"sync"

	"github.com/gorilla/websocket"
	"mindfs/server/internal/agent"
	"mindfs/server/internal/agent/unified"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/router"
	"mindfs/server/internal/session"
)

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

// WSHandler manages JSON-RPC over WebSocket.
type WSHandler struct {
	Router    *router.Router
	Root      string
	Registry  *fs.Registry
	Sessions  *SessionService
	Agents    *agent.Pool
	TaskQueue *agent.TaskQueue
	watcherMu sync.Mutex
	watchers  map[string]*fs.SharedFileWatcher // rootPath -> SharedFileWatcher
	connMu    sync.RWMutex
	conns     map[*websocket.Conn]bool
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
		var raw map[string]any
		if err := json.Unmarshal(message, &raw); err != nil {
			_ = conn.WriteJSON(JSONRPCResponse{JSONRPC: "2.0", ID: "", Error: &JSONRPCError{Code: -32700, Message: "parse error"}})
			continue
		}
		if _, ok := raw["jsonrpc"]; ok {
			var req JSONRPCRequest
			if err := json.Unmarshal(message, &req); err != nil {
				_ = conn.WriteJSON(JSONRPCResponse{JSONRPC: "2.0", ID: req.ID, Error: &JSONRPCError{Code: -32700, Message: "parse error"}})
				continue
			}
			resp := h.handleRequest(r.Context(), req)
			_ = conn.WriteJSON(resp)
			continue
		}
		var req WSRequest
		if err := json.Unmarshal(message, &req); err != nil {
			h.sendWSError(conn, "", "invalid_request", "invalid request")
			continue
		}
		h.handleWSRequest(r.Context(), conn, req)
	}
}

func (h *WSHandler) handleRequest(ctx context.Context, req JSONRPCRequest) JSONRPCResponse {
	if req.JSONRPC == "" {
		req.JSONRPC = "2.0"
	}
	switch req.Method {
	case "action.dispatch":
		return h.handleAction(ctx, req)
	default:
		return JSONRPCResponse{JSONRPC: "2.0", ID: req.ID, Error: &JSONRPCError{Code: -32601, Message: "method not found"}}
	}
}

func (h *WSHandler) handleAction(ctx context.Context, req JSONRPCRequest) JSONRPCResponse {
	if h.Router == nil {
		return JSONRPCResponse{JSONRPC: "2.0", ID: req.ID, Error: &JSONRPCError{Code: -32000, Message: "router not configured"}}
	}
	params := req.Params
	action, _ := params["action"].(string)
	path, _ := params["path"].(string)
	version, _ := params["version"].(string)
	root, _ := params["root"].(string)
	contextMap, _ := params["context"].(map[string]any)
	metaMap, _ := params["meta"].(map[string]any)
	resp, err := h.Router.Dispatch(ctx, router.ActionRequest{
		Action:  action,
		Path:    path,
		Context: contextMap,
		Meta:    metaMap,
		Version: version,
		Root:    root,
	})
	if err != nil {
		return JSONRPCResponse{JSONRPC: "2.0", ID: req.ID, Error: &JSONRPCError{Code: -32001, Message: err.Error()}}
	}
	result := map[string]any{
		"status":  resp.Status,
		"handled": resp.Handled,
	}
	if len(resp.Data) > 0 {
		result["data"] = resp.Data
	}
	if len(resp.View) > 0 {
		result["view"] = resp.View
	}
	if len(resp.Effects) > 0 {
		result["effects"] = resp.Effects
	}
	if len(resp.Error) > 0 {
		result["error"] = resp.Error
	}
	return JSONRPCResponse{JSONRPC: "2.0", ID: req.ID, Result: result}
}

func (h *WSHandler) handleWSRequest(ctx context.Context, conn *websocket.Conn, req WSRequest) {
	switch req.Type {
	case "session.create":
		h.handleSessionCreate(ctx, conn, req)
	case "session.message":
		h.handleSessionMessage(ctx, conn, req)
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
	created, resolved, err := h.Sessions.CreateSession(ctx, rootID, input)
	if err != nil {
		h.sendWSError(conn, req.ID, "session.create_failed", err.Error())
		return
	}
	if resolved != nil {
		h.startWatcher(ctx, rootID, created.Key, resolved.Path, resolved.ManagedDir)
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

	// 添加用户消息（审计日志在 SessionService 中处理）
	_, resolved, err := h.Sessions.AddMessage(ctx, rootID, key, "user", content)
	if err != nil {
		h.sendWSError(conn, req.ID, "session.not_found", err.Error())
		return
	}

	if h.Agents == nil {
		h.sendWS(conn, WSResponse{
			ID:   req.ID,
			Type: "session.done",
			Payload: map[string]any{
				"session_key": key,
			},
		})
		return
	}

	sessionItem, err := h.Sessions.GetSession(ctx, rootID, key)
	if err != nil {
		h.sendWSError(conn, req.ID, "session.not_found", err.Error())
		return
	}

	if resolved != nil {
		h.startWatcher(ctx, rootID, sessionItem.Key, resolved.Path, resolved.ManagedDir)
	}

	proc, err := h.Agents.GetOrCreate(ctx, sessionItem.Key, sessionItem.Agent, resolved.Path)
	if err != nil {
		h.sendWSError(conn, req.ID, "agent.not_available", err.Error())
		return
	}

	manager, _, _ := h.Sessions.GetManager(rootID)
	sharedWatcher := h.getSharedWatcher(resolved.Path)
	var responseText string
	err = proc.SendMessage(ctx, content, func(update unified.SessionUpdate) {
		// Track file writes from ToolCall (precise tracking via ACP protocol)
		if update.Type == unified.UpdateTypeToolCall {
			if toolCall, ok := update.Data.(unified.ToolCall); ok {
				if toolCall.IsWriteOperation() && resolved != nil {
					for _, path := range toolCall.GetAffectedPaths() {
						// Record pending write for SharedFileWatcher (precise matching)
						if sharedWatcher != nil {
							sharedWatcher.RecordPendingWrite(sessionItem.Key, path)
						}
						// Also record directly to session
						if manager != nil {
							h.recordSessionFile(ctx, manager, sessionItem.Key, resolved.Path, resolved.ManagedDir, path)
						}
					}
				}
			}
		}

		// Mark session as active on any update
		if sharedWatcher != nil {
			sharedWatcher.MarkSessionActive(sessionItem.Key)
		}

		// Convert to legacy chunk format for backward compatibility
		chunk := updateToChunk(update)
		if chunk.Content != "" {
			responseText += chunk.Content
		}
		h.sendWS(conn, WSResponse{
			Type: "session.stream",
			Payload: map[string]any{
				"session_key": key,
				"chunk":       chunk,
			},
		})
	})
	if err != nil {
		h.sendWSError(conn, req.ID, "agent.timeout", err.Error())
		return
	}

	// 添加 agent 响应
	if manager != nil {
		_, _ = manager.AddExchange(ctx, key, "agent", responseText)
	}

	h.sendWS(conn, WSResponse{
		ID:   req.ID,
		Type: "session.done",
		Payload: map[string]any{
			"session_key": key,
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

	// Get rootPath before closing session
	rootPath, _, _ := h.resolveRootPaths(rootID)

	closed, err := h.Sessions.CloseSession(ctx, rootID, key)
	if err != nil {
		h.sendWSError(conn, req.ID, "session.not_found", err.Error())
		return
	}

	if h.Agents != nil {
		h.Agents.Close(closed.Key)
	}
	if rootPath != "" {
		h.stopWatcher(rootPath, closed.Key)
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

// updateToChunk converts a unified SessionUpdate to a legacy StreamChunk.
func updateToChunk(update unified.SessionUpdate) agent.StreamChunk {
	switch update.Type {
	case unified.UpdateTypeMessageChunk:
		if chunk, ok := update.Data.(unified.MessageChunk); ok {
			return agent.StreamChunk{Type: "text", Content: chunk.Content}
		}
	case unified.UpdateTypeThoughtChunk:
		if chunk, ok := update.Data.(unified.ThoughtChunk); ok {
			return agent.StreamChunk{Type: "thinking", Content: chunk.Content}
		}
	case unified.UpdateTypeToolCall:
		if tc, ok := update.Data.(unified.ToolCall); ok {
			return agent.StreamChunk{Type: "tool_call", Tool: tc.Name}
		}
	case unified.UpdateTypeToolUpdate:
		if tu, ok := update.Data.(unified.ToolCallUpdate); ok {
			return agent.StreamChunk{Type: "tool_result", Content: tu.Result}
		}
	case unified.UpdateTypeMessageDone:
		return agent.StreamChunk{Type: "done"}
	}
	return agent.StreamChunk{}
}

func (h *WSHandler) resolveRootPaths(rootID string) (string, string, error) {
	resolved, err := resolveRoot(rootID, h.Root, h.Registry)
	if err != nil {
		return "", "", err
	}
	return resolved.Path, resolved.ManagedDir, nil
}

func (h *WSHandler) startWatcher(ctx context.Context, rootID, sessionKey, rootPath, managedDir string) {
	if sessionKey == "" || rootPath == "" || managedDir == "" {
		return
	}
	manager, _, err := h.Sessions.GetManager(rootID)
	if err != nil {
		return
	}

	// Get or create shared watcher for this rootPath
	watcher, err := fs.GetSharedWatcher(rootPath, managedDir, func(rel, sessKey string, size int64) {
		h.recordSessionFile(ctx, manager, sessKey, rootPath, managedDir, rel)
	})
	if err != nil {
		return
	}

	// Register this session with the shared watcher
	watcher.RegisterSession(sessionKey)

	// Store reference for cleanup
	h.watcherMu.Lock()
	if h.watchers == nil {
		h.watchers = make(map[string]*fs.SharedFileWatcher)
	}
	h.watchers[rootPath] = watcher
	h.watcherMu.Unlock()
}

func (h *WSHandler) stopWatcher(rootPath, sessionKey string) {
	h.watcherMu.Lock()
	watcher, ok := h.watchers[rootPath]
	h.watcherMu.Unlock()

	if !ok || watcher == nil {
		return
	}

	// Unregister this session
	watcher.UnregisterSession(sessionKey)

	// If no more sessions, remove the watcher
	if watcher.SessionCount() == 0 {
		h.watcherMu.Lock()
		delete(h.watchers, rootPath)
		h.watcherMu.Unlock()
		watcher.Close()
	}
}

// getSharedWatcher returns the shared watcher for a rootPath if it exists.
func (h *WSHandler) getSharedWatcher(rootPath string) *fs.SharedFileWatcher {
	h.watcherMu.Lock()
	defer h.watcherMu.Unlock()
	if h.watchers == nil {
		return nil
	}
	return h.watchers[rootPath]
}

func (h *WSHandler) recordSessionFile(ctx context.Context, manager *session.Manager, sessionKey, rootPath, managedDir, path string) {
	if manager == nil || sessionKey == "" || path == "" {
		return
	}
	relPath := path
	if filepath.IsAbs(path) {
		if rel, err := filepath.Rel(rootPath, path); err == nil {
			relPath = rel
		}
	}
	relPath = filepath.ToSlash(relPath)
	if relPath == "." || relPath == ".." || relPath == "" {
		return
	}
	if len(relPath) >= len(".mindfs") && relPath[:len(".mindfs")] == ".mindfs" {
		return
	}
	_, _ = manager.AddRelatedFile(ctx, sessionKey, session.RelatedFile{
		Path:             relPath,
		Relation:         "output",
		CreatedBySession: true,
	})
	_ = fs.UpdateFileMeta(managedDir, relPath, sessionKey, "agent")
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
		"id":         t.ID,
		"session_key": t.SessionKey,
		"type":       t.Type,
		"status":     string(t.Status),
		"progress":   t.Progress,
		"created_at": t.CreatedAt,
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
