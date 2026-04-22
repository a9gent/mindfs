package api

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/e2ee"
	"mindfs/server/internal/session"

	"github.com/gorilla/websocket"
)

type StreamHub struct {
	mu              sync.RWMutex
	e2eeManager     *e2ee.Manager
	clients         map[string]*websocket.Conn
	connLocks       map[*websocket.Conn]*sync.Mutex
	sessionClients  map[string]map[string]struct{}
	pendingSessions map[string]*SessionPendingState
	replayStates    map[string]*ClientReplayState
	completed       map[string]*CompletedSessionState
}

type PendingUserMessage struct {
	Agent     string    `json:"agent,omitempty"`
	Model     string    `json:"model,omitempty"`
	Mode      string    `json:"mode,omitempty"`
	Effort    string    `json:"effort,omitempty"`
	Content   string    `json:"content"`
	Timestamp time.Time `json:"timestamp"`
}

type SessionPendingState struct {
	User         *PendingUserMessage
	ReplyingList []StreamEvent
}

type ClientStreamStatus string

const (
	ClientStreamStatusReplay ClientStreamStatus = "replay"
	ClientStreamStatusLive   ClientStreamStatus = "live"
)

type ClientReplayState struct {
	Status      ClientStreamStatus
	ReplayIndex int
}

type CompletedSessionState struct {
	RequestID string
	Completed time.Time
}

type replayStep struct {
	events []StreamEvent
	live   bool
}

func blank(value string) bool {
	return strings.TrimSpace(value) == ""
}

func NewStreamHub(e2eeManager *e2ee.Manager) *StreamHub {
	return &StreamHub{
		e2eeManager:     e2eeManager,
		clients:         make(map[string]*websocket.Conn),
		connLocks:       make(map[*websocket.Conn]*sync.Mutex),
		sessionClients:  make(map[string]map[string]struct{}),
		pendingSessions: make(map[string]*SessionPendingState),
		replayStates:    make(map[string]*ClientReplayState),
		completed:       make(map[string]*CompletedSessionState),
	}
}

func pendingClientKey(clientID, sessionKey string) string {
	return clientID + "::" + sessionKey
}

func cloneEvent(ev StreamEvent) StreamEvent {
	return StreamEvent{Type: ev.Type, Data: ev.Data}
}

func cloneUserExchange(msg *PendingUserMessage) *session.Exchange {
	if msg == nil {
		return nil
	}
	return &session.Exchange{
		Role:      "user",
		Agent:     msg.Agent,
		Model:     msg.Model,
		Mode:      msg.Mode,
		Effort:    msg.Effort,
		Content:   msg.Content,
		Timestamp: msg.Timestamp,
	}
}

func buildSessionStreamResponse(rootID, sessionKey string, event *StreamEvent) WSResponse {
	return WSResponse{
		Type: "session.stream",
		Payload: map[string]any{
			"root_id":     rootID,
			"session_key": sessionKey,
			"event":       event,
		},
	}
}

func buildSessionDoneResponse(rootID, sessionKey, requestID string) WSResponse {
	return WSResponse{
		ID:   requestID,
		Type: "session.done",
		Payload: map[string]any{
			"root_id":     rootID,
			"session_key": sessionKey,
		},
	}
}

func buildSessionUserMessageResponse(rootID, sessionKey, sessionType, sessionName, agentName, model, mode, effort, content string, timestamp time.Time) WSResponse {
	sessionPayload := map[string]any{
		"key":        sessionKey,
		"type":       sessionType,
		"agent":      agentName,
		"model":      model,
		"mode":       mode,
		"effort":     effort,
		"created_at": timestamp,
		"updated_at": timestamp,
	}
	if strings.TrimSpace(sessionName) != "" {
		sessionPayload["name"] = sessionName
	}
	return WSResponse{
		Type: "session.user_message",
		Payload: map[string]any{
			"root_id":     rootID,
			"session_key": sessionKey,
			"session":     sessionPayload,
			"exchange": map[string]any{
				"role":      "user",
				"agent":     agentName,
				"model":     model,
				"mode":      mode,
				"effort":    effort,
				"content":   content,
				"timestamp": timestamp,
			},
		},
	}
}

func (h *StreamHub) ensurePendingSessionLocked(sessionKey string) *SessionPendingState {
	state := h.pendingSessions[sessionKey]
	if state == nil {
		state = &SessionPendingState{}
		h.pendingSessions[sessionKey] = state
	}
	return state
}

func (h *StreamHub) clearReplayStatesForSessionLocked(sessionKey string) {
	for _, replayKey := range h.getReplayKeyListLocked(sessionKey, "") {
		delete(h.replayStates, replayKey)
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
	for _, replayKey := range h.getReplayKeyListLocked("", clientID) {
		delete(h.replayStates, replayKey)
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

func (h *StreamHub) GetSessionClientIDs(sessionKey string, liveOnly bool) []string {
	if blank(sessionKey) {
		return nil
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	clientSet := h.sessionClients[sessionKey]
	if len(clientSet) == 0 {
		return nil
	}
	out := make([]string, 0, len(clientSet))
	for clientID := range clientSet {
		if h.clients[clientID] == nil {
			continue
		}
		if liveOnly && h.isReplayClientLocked(clientID, sessionKey) {
			continue
		}
		out = append(out, clientID)
	}
	return out
}

func (h *StreamHub) getAllClientIDs() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if len(h.clients) == 0 {
		return nil
	}
	clientIDs := make([]string, 0, len(h.clients))
	for clientID, conn := range h.clients {
		if conn != nil {
			clientIDs = append(clientIDs, clientID)
		}
	}
	return clientIDs
}

func (h *StreamHub) SetPendingUser(sessionKey, agent, model, mode, effort, content string) *PendingUserMessage {
	h.mu.Lock()
	defer h.mu.Unlock()
	state := h.ensurePendingSessionLocked(sessionKey)
	delete(h.completed, sessionKey)
	state.User = &PendingUserMessage{
		Agent:     agent,
		Model:     model,
		Mode:      mode,
		Effort:    effort,
		Content:   content,
		Timestamp: time.Now().UTC(),
	}
	state.ReplyingList = nil
	h.clearReplayStatesForSessionLocked(sessionKey)
	return &PendingUserMessage{
		Agent:     state.User.Agent,
		Model:     state.User.Model,
		Mode:      state.User.Mode,
		Effort:    state.User.Effort,
		Content:   state.User.Content,
		Timestamp: state.User.Timestamp,
	}
}

func (h *StreamHub) GetPendingUserExchange(sessionKey string) *session.Exchange {
	h.mu.Lock()
	defer h.mu.Unlock()
	state := h.pendingSessions[sessionKey]
	if state == nil {
		return nil
	}
	return cloneUserExchange(state.User)
}

func (h *StreamHub) AppendReplyEvent(sessionKey string, event StreamEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	state := h.ensurePendingSessionLocked(sessionKey)
	state.ReplyingList = append(state.ReplyingList, cloneEvent(event))
}

func (h *StreamHub) ReplayPending(rootID, clientID, sessionKey string) {
	h.mu.Lock()
	h.replayStates[pendingClientKey(clientID, sessionKey)] = &ClientReplayState{
		Status:      ClientStreamStatusReplay,
		ReplayIndex: 0,
	}
	h.mu.Unlock()

	for {
		step := h.collectReplayStep(clientID, sessionKey)
		h.replayStepToClient(rootID, clientID, sessionKey, step.events)
		if step.live {
			h.replayCompletionToClient(rootID, clientID, sessionKey)
			return
		}
	}
}

func (h *StreamHub) HasReplayClients(rootID, sessionKey string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, replayKey := range h.getReplayKeyListLocked(sessionKey, "") {
		replay := h.replayStates[replayKey]
		if replay != nil && replay.Status == ClientStreamStatusReplay {
			return true
		}
	}
	return false
}

func (h *StreamHub) ClearSessionPending(sessionKey string) {
	if blank(sessionKey) {
		return
	}
	for h.HasReplayClients("", sessionKey) {
		time.Sleep(10 * time.Millisecond)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.pendingSessions, sessionKey)
	h.clearReplayStatesForSessionLocked(sessionKey)
}

func (h *StreamHub) SendToClient(clientID string, resp WSResponse) {
	if blank(clientID) {
		return
	}
	h.mu.RLock()
	conn := h.clients[clientID]
	h.mu.RUnlock()
	if conn == nil {
		return
	}
	_ = h.WriteJSON(clientID, conn, resp)
}

func (h *StreamHub) BroadcastAll(resp WSResponse) {
	for _, clientID := range h.getAllClientIDs() {
		h.SendToClient(clientID, resp)
	}
}

func (h *StreamHub) BroadcastSessionStream(rootID, sessionKey string, event *StreamEvent) {
	if event == nil {
		return
	}
	h.AppendReplyEvent(sessionKey, *event)
	for _, clientID := range h.GetSessionClientIDs(sessionKey, true) {
		resp := buildSessionStreamResponse(rootID, sessionKey, event)
		h.SendToClient(clientID, resp)
	}
}

func (h *StreamHub) BroadcastSessionDone(rootID, sessionKey, requestID string) {
	h.mu.Lock()
	h.completed[sessionKey] = &CompletedSessionState{
		RequestID: requestID,
		Completed: time.Now().UTC(),
	}
	h.mu.Unlock()
	resp := buildSessionDoneResponse(rootID, sessionKey, requestID)
	for _, clientID := range h.GetSessionClientIDs(sessionKey, false) {
		h.SendToClient(clientID, resp)
	}
}

func (h *StreamHub) BroadcastSessionUserMessage(
	rootID string,
	sessionKey string,
	sessionType string,
	sessionName string,
	agentName string,
	model string,
	mode string,
	effort string,
	content string,
	excludeClientID string,
) {
	pendingUser := h.SetPendingUser(sessionKey, agentName, model, mode, effort, content)
	resp := buildSessionUserMessageResponse(rootID, sessionKey, sessionType, sessionName, agentName, model, mode, effort, content, pendingUser.Timestamp)
	for _, clientID := range h.GetSessionClientIDs(sessionKey, false) {
		if clientID == excludeClientID {
			continue
		}
		h.SendToClient(clientID, resp)
	}
}

func (h *StreamHub) WriteJSON(clientID string, conn *websocket.Conn, value any) error {
	if conn == nil {
		return nil
	}
	lock := h.getConnLock(conn)
	lock.Lock()
	defer lock.Unlock()
	if h.e2eeManager != nil && h.e2eeManager.Enabled() {
		if resp, ok := value.(WSResponse); ok && resp.Type == "e2ee.error" {
			return conn.WriteJSON(resp)
		}
		sess, err := h.e2eeManager.SessionForClient(clientID)
		if err != nil {
			return nil
		}
		payload, err := json.Marshal(value)
		if err != nil {
			return err
		}
		envelope, err := e2ee.EncryptBytes(sess.Key, payload)
		if err != nil {
			return err
		}
		return conn.WriteJSON(envelope)
	}
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

func (h *StreamHub) collectReplayStep(clientID, sessionKey string) replayStep {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.nextReplayStepLocked(clientID, sessionKey)
}

func (h *StreamHub) nextReplayStepLocked(clientID, sessionKey string) replayStep {
	clientKey := pendingClientKey(clientID, sessionKey)
	replay := h.replayStates[clientKey]
	if replay == nil {
		return replayStep{live: true}
	}
	state := h.pendingSessions[sessionKey]
	if state == nil {
		replay.Status = ClientStreamStatusLive
		return replayStep{live: true}
	}
	if replay.ReplayIndex >= len(state.ReplyingList) {
		replay.Status = ClientStreamStatusLive
		return replayStep{live: true}
	}
	start := replay.ReplayIndex
	end := len(state.ReplyingList)
	events := append([]StreamEvent(nil), state.ReplyingList[start:end]...)
	replay.ReplayIndex = end
	return replayStep{events: events}
}

func (h *StreamHub) replayStepToClient(rootID, clientID, sessionKey string, events []StreamEvent) {
	for i := range events {
		h.SendToClient(clientID, buildSessionStreamResponse(rootID, sessionKey, &events[i]))
	}
}

func (h *StreamHub) replayCompletionToClient(rootID, clientID, sessionKey string) {
	if blank(rootID) || blank(clientID) || blank(sessionKey) {
		return
	}
	h.mu.Lock()
	completed := h.completed[sessionKey]
	if completed == nil {
		h.mu.Unlock()
		return
	}
	if time.Since(completed.Completed) > 2*time.Minute {
		delete(h.completed, sessionKey)
		h.mu.Unlock()
		return
	}
	requestID := completed.RequestID
	h.mu.Unlock()
	h.SendToClient(clientID, buildSessionDoneResponse(rootID, sessionKey, requestID))
}

func (h *StreamHub) isReplayClientLocked(clientID, sessionKey string) bool {
	for _, replayKey := range h.getReplayKeyListLocked(sessionKey, clientID) {
		state := h.replayStates[replayKey]
		return state != nil && state.Status != ClientStreamStatusLive
	}
	return false
}

func (h *StreamHub) getReplayKeyListLocked(sessionKey, clientID string) []string {
	if len(h.replayStates) == 0 {
		return nil
	}
	keys := make([]string, 0, len(h.replayStates))
	for replayKey := range h.replayStates {
		if sessionKey != "" && !strings.HasSuffix(replayKey, "::"+sessionKey) {
			continue
		}
		if clientID != "" && !strings.HasPrefix(replayKey, clientID+"::") {
			continue
		}
		keys = append(keys, replayKey)
	}
	return keys
}
