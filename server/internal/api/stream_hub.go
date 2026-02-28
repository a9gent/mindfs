package api

import (
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

type StreamHub struct {
	mu             sync.RWMutex
	clients        map[string]*websocket.Conn
	connLocks      map[*websocket.Conn]*sync.Mutex
	sessionClients map[string]map[string]struct{}
}

func blank(value string) bool {
	return strings.TrimSpace(value) == ""
}

func NewStreamHub() *StreamHub {
	return &StreamHub{
		clients:        make(map[string]*websocket.Conn),
		connLocks:      make(map[*websocket.Conn]*sync.Mutex),
		sessionClients: make(map[string]map[string]struct{}),
	}
}

func (h *StreamHub) RegisterClient(clientID string, conn *websocket.Conn) {
	if blank(clientID) || conn == nil {
		return
	}
	h.mu.Lock()
	h.clients[clientID] = conn
	if _, ok := h.connLocks[conn]; !ok {
		h.connLocks[conn] = &sync.Mutex{}
	}
	h.mu.Unlock()
}

func (h *StreamHub) UnregisterClient(clientID string, conn *websocket.Conn) {
	if blank(clientID) {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	existing := h.clients[clientID]
	if existing != conn {
		return
	}
	delete(h.clients, clientID)
	delete(h.connLocks, conn)
	for sessionKey, clientSet := range h.sessionClients {
		delete(clientSet, clientID)
		if len(clientSet) == 0 {
			delete(h.sessionClients, sessionKey)
		}
	}
}

func (h *StreamHub) BindSessionClient(sessionKey, clientID string) {
	if blank(sessionKey) || blank(clientID) {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[clientID]; !ok {
		return
	}
	clientSet := h.sessionClients[sessionKey]
	if clientSet == nil {
		clientSet = make(map[string]struct{})
		h.sessionClients[sessionKey] = clientSet
	}
	clientSet[clientID] = struct{}{}
}

func (h *StreamHub) GetSessionConns(sessionKey string) []*websocket.Conn {
	if blank(sessionKey) {
		return nil
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	clientSet := h.sessionClients[sessionKey]
	if len(clientSet) == 0 {
		return nil
	}
	conns := make([]*websocket.Conn, 0, len(clientSet))
	for clientID := range clientSet {
		conn := h.clients[clientID]
		if conn != nil {
			conns = append(conns, conn)
		}
	}
	return conns
}

func (h *StreamHub) BroadcastAll(resp WSResponse) {
	h.mu.RLock()
	conns := make([]*websocket.Conn, 0, len(h.clients))
	for _, conn := range h.clients {
		if conn != nil {
			conns = append(conns, conn)
		}
	}
	h.mu.RUnlock()
	for _, conn := range conns {
		_ = h.WriteJSON(conn, resp)
	}
}

func (h *StreamHub) BroadcastSessionStream(sessionKey string, event *StreamEvent) {
	if event == nil {
		return
	}
	conns := h.GetSessionConns(sessionKey)
	for _, conn := range conns {
		if conn == nil {
			continue
		}
		_ = h.WriteJSON(conn, WSResponse{
			Type: "session.stream",
			Payload: map[string]any{
				"session_key": sessionKey,
				"event":       event,
			},
		})
	}
}

func (h *StreamHub) BroadcastSessionDone(sessionKey, requestID string) {
	conns := h.GetSessionConns(sessionKey)
	for _, conn := range conns {
		if conn == nil {
			continue
		}
		_ = h.WriteJSON(conn, WSResponse{
			ID:   requestID,
			Type: "session.done",
			Payload: map[string]any{
				"session_key": sessionKey,
			},
		})
	}
}

func (h *StreamHub) WriteJSON(conn *websocket.Conn, value any) error {
	if conn == nil {
		return nil
	}
	lock := h.getConnLock(conn)
	lock.Lock()
	defer lock.Unlock()
	return conn.WriteJSON(value)
}

func (h *StreamHub) getConnLock(conn *websocket.Conn) *sync.Mutex {
	h.mu.RLock()
	lock := h.connLocks[conn]
	h.mu.RUnlock()
	if lock != nil {
		return lock
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if existing := h.connLocks[conn]; existing != nil {
		return existing
	}
	created := &sync.Mutex{}
	h.connLocks[conn] = created
	return created
}
