package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/api/usecase"
	"mindfs/server/internal/e2ee"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/githubimport"
	"mindfs/server/internal/session"
	"mindfs/server/internal/update"

	"github.com/gorilla/websocket"
)

const (
	wsPingInterval = 30 * time.Second
	wsPongWait     = 2 * time.Minute
	wsProofQuery   = "e2ee_proof"
	wsTSQuery      = "e2ee_ts"

	sessionDoneSettleWindow = 50 * time.Millisecond
	sessionDoneMaxWait      = 2 * time.Second
)

var upgrader = websocket.Upgrader{}

// WSHandler manages JSON-RPC over WebSocket.
type WSHandler struct {
	AppContext      *AppContext
	fileOnce        sync.Once
	relatedFileOnce sync.Once
	proberOnce      sync.Once
	updateOnce      sync.Once
	githubOnce      sync.Once
	requestMu       sync.Mutex
	requests        map[string]time.Time
}

type StreamEvent struct {
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
}

type sessionMessageJob struct {
	RootID          string
	Key             string
	RequestID       string
	SessionType     string
	SessionName     string
	Shell           string
	TerminalCols    int
	User            PendingUserMessage
	ClientCtx       usecase.ClientContext
	ExcludeClientID string
	Queued          bool
}

type turnUpdateTracker struct {
	mu           sync.Mutex
	inFlight     int
	lastActivity time.Time
}

func newTurnUpdateTracker() *turnUpdateTracker {
	return &turnUpdateTracker{lastActivity: time.Now()}
}

func (t *turnUpdateTracker) Begin() {
	if t == nil {
		return
	}
	t.mu.Lock()
	t.inFlight++
	t.lastActivity = time.Now()
	t.mu.Unlock()
}

func (t *turnUpdateTracker) End() {
	if t == nil {
		return
	}
	t.mu.Lock()
	if t.inFlight > 0 {
		t.inFlight--
	}
	t.lastActivity = time.Now()
	t.mu.Unlock()
}

func (t *turnUpdateTracker) WaitIdle(ctx context.Context, settleWindow, maxWait time.Duration) bool {
	if t == nil {
		return true
	}
	if settleWindow <= 0 {
		settleWindow = 50 * time.Millisecond
	}
	if maxWait <= 0 {
		maxWait = 2 * time.Second
	}
	deadline := time.Now().Add(maxWait)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()

	for {
		t.mu.Lock()
		inFlight := t.inFlight
		idleFor := time.Since(t.lastActivity)
		t.mu.Unlock()
		if inFlight == 0 && idleFor >= settleWindow {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
		}
	}
}

// ServeHTTP upgrades the connection and processes JSON-RPC messages.
func (h *WSHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.fileOnce.Do(func() {
		if h.AppContext != nil {
			h.AppContext.AddFileChangeListener(h.broadcastFileChange)
			h.AppContext.AddFileChangeBatchListener(h.broadcastFileChangeBatch)
		}
	})
	h.relatedFileOnce.Do(func() {
		if h.AppContext != nil {
			h.AppContext.AddRelatedFileListener(h.broadcastRelatedFileChange)
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
	h.githubOnce.Do(func() {
		if h.AppContext != nil && h.AppContext.GetGitHubImportService() != nil {
			h.AppContext.GetGitHubImportService().AddListener(h.broadcastGitHubImport)
		}
	})
	clientID := strings.TrimSpace(r.URL.Query().Get("client_id"))
	if clientID == "" {
		http.Error(w, "client_id required", http.StatusBadRequest)
		return
	}
	if err := h.requireWSProof(r, clientID); err != nil {
		respondError(w, http.StatusUnauthorized, err)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	log.Printf("[ws] connected client=%s remote=%s path=%s", clientID, r.RemoteAddr, r.URL.Path)
	if h.AppContext != nil {
		h.AppContext.GetSessionStreamHub().RegisterClient(clientID, conn)
		h.pushInitialAppUpdate(clientID)
		h.pushInitialGitHubImports(clientID)
	}
	defer func() {
		if h.AppContext != nil {
			h.AppContext.GetSessionStreamHub().UnregisterClient(clientID, conn)
		}
		log.Printf("[ws] disconnected client=%s remote=%s path=%s", clientID, r.RemoteAddr, r.URL.Path)
		conn.Close()
	}()

	conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})

	done := make(chan struct{})
	defer close(done)

	go func() {
		ticker := time.NewTicker(wsPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					_ = conn.Close()
					return
				}
			case <-done:
				return
			}
		}
	}()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			if closeErr, ok := err.(*websocket.CloseError); ok {
				log.Printf("[ws] read.closed client=%s remote=%s path=%s code=%d text=%q", clientID, r.RemoteAddr, r.URL.Path, closeErr.Code, closeErr.Text)
			} else {
				log.Printf("[ws] read.error client=%s remote=%s path=%s err=%v", clientID, r.RemoteAddr, r.URL.Path, err)
			}
			return
		}
		if e2eeManager := h.AppContext.GetE2EEManager(); e2eeManager != nil && e2eeManager.Enabled() {
			sess, err := e2eeManager.SessionForClient(clientID)
			if err != nil {
				h.sendE2EEError(conn, "", err.Error())
				continue
			}
			var envelope e2ee.CipherEnvelope
			if err := json.Unmarshal(message, &envelope); err != nil {
				h.sendE2EEError(conn, "", "e2ee_session_missing")
				continue
			}
			message, err = e2ee.DecryptBytes(sess.Key, &envelope)
			if err != nil {
				h.sendE2EEError(conn, "", "e2ee_proof_invalid")
				continue
			}
		}
		var req WSRequest
		if err := json.Unmarshal(message, &req); err != nil {
			h.sendWSError(conn, clientID, "", "invalid_request", "invalid request")
			continue
		}
		h.handleWSRequest(r.Context(), conn, clientID, req)
	}
}

func (h *WSHandler) requireWSProof(r *http.Request, clientID string) error {
	if h == nil || h.AppContext == nil {
		return nil
	}
	manager := h.AppContext.GetE2EEManager()
	if manager == nil || !manager.Enabled() {
		return nil
	}
	ts := strings.TrimSpace(r.URL.Query().Get(wsTSQuery))
	proof := strings.TrimSpace(r.URL.Query().Get(wsProofQuery))
	if clientID == "" || ts == "" || proof == "" {
		return errInvalidRequest("e2ee_proof_required")
	}
	sess, err := manager.SessionForClient(clientID)
	if err != nil {
		return errInvalidRequest(err.Error())
	}
	timestamp, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return errInvalidRequest("invalid_e2ee_ts")
	}
	now := time.Now().UTC()
	if timestamp.Before(now.Add(-requestProofMaxSkew)) || timestamp.After(now.Add(requestProofMaxSkew)) {
		return errInvalidRequest("e2ee_proof_expired")
	}
	expected := e2ee.BuildRequestProof(sess.Key, r.Method, wsProofPath(r), ts, clientID)
	if !e2ee.VerifyProof(expected, proof) {
		return errInvalidRequest("e2ee_proof_invalid")
	}
	return nil
}

func wsProofPath(r *http.Request) string {
	if r == nil || r.URL == nil {
		return ""
	}
	next := *r.URL
	query := cloneQuery(next.Query())
	query.Del(wsTSQuery)
	query.Del(wsProofQuery)
	next.RawQuery = query.Encode()
	if next.RawQuery == "" {
		return next.Path
	}
	return next.Path + "?" + next.RawQuery
}

func cloneQuery(values url.Values) url.Values {
	next := make(url.Values, len(values))
	for key, value := range values {
		next[key] = append([]string(nil), value...)
	}
	return next
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

func (h *WSHandler) broadcastFileChangeBatch(change fs.FileChangeBatchEvent) {
	events := make([]map[string]any, 0, len(change.Events))
	for _, event := range change.Events {
		events = append(events, map[string]any{
			"path":   event.Path,
			"op":     event.Op,
			"is_dir": event.IsDir,
		})
	}
	resp := WSResponse{
		Type: "file.changed.batch",
		Payload: map[string]any{
			"root_id": change.RootID,
			"paths":   change.Paths,
			"dirs":    change.Dirs,
			"events":  events,
		},
	}
	h.broadcastWS(resp)
}

func (h *WSHandler) broadcastRelatedFileChange(change fs.RelatedFileEvent) {
	resp := WSResponse{
		Type: "session.related_files.updated",
		Payload: map[string]any{
			"root_id":     change.RootID,
			"session_key": change.SessionKey,
			"path":        change.Path,
		},
	}
	h.broadcastWS(resp)
}

func (h *WSHandler) broadcastSessionMetaUpdated(rootID string, sess *session.Session) {
	if sess == nil {
		h.broadcastWS(WSResponse{Type: "session.meta.updated"})
		return
	}
	resp := WSResponse{
		Type: "session.meta.updated",
		Payload: map[string]any{
			"root_id": rootID,
			"session": map[string]any{
				"key":                 sess.Key,
				"type":                sess.Type,
				"parent_session_key":  sess.ParentSessionKey,
				"parent_tool_call_id": sess.ParentToolCallID,
				"name":                sess.Name,
				"model":               sess.Model,
				"mode":                session.InferModeFromSession(sess),
				"effort":              session.InferEffortFromSession(sess),
				"fast_service":        session.InferFastServiceFromSession(sess),
				"plan_mode":           sess.PlanMode,
				"updated_at":          sess.UpdatedAt,
			},
		},
	}
	h.broadcastWS(resp)
}

func (h *WSHandler) broadcastAgentStatusChange(status agent.Status) {
	resp := WSResponse{
		Type: "agent.status.changed",
		Payload: map[string]any{
			"name":                  status.Name,
			"installed":             status.Installed,
			"available":             status.Available,
			"version":               status.Version,
			"error":                 status.Error,
			"last_probe":            status.LastProbe,
			"current_model_id":      status.CurrentModelID,
			"current_mode_id":       status.CurrentModeID,
			"default_model_id":      status.DefaultModelID,
			"default_effort":        status.DefaultEffort,
			"default_fast_service":  status.DefaultFastService,
			"supports_fast_service": status.SupportsFastService,
			"efforts":               status.Efforts,
			"models":                status.Models,
			"modes":                 status.Modes,
			"models_error":          status.ModelsError,
			"modes_error":           status.ModesError,
			"commands":              status.Commands,
			"commands_error":        status.CommandsError,
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

func (h *WSHandler) broadcastGitHubImport(status githubimport.Status) {
	resp := WSResponse{
		Type:    "github.import",
		Payload: map[string]any{"status": status},
	}
	h.broadcastWS(resp)
}

func (h *WSHandler) pushInitialGitHubImports(clientID string) {
	if h.AppContext == nil || h.AppContext.GetGitHubImportService() == nil {
		return
	}
	for _, status := range h.AppContext.GetGitHubImportService().ActiveStatuses() {
		h.AppContext.GetSessionStreamHub().SendToClient(clientID, WSResponse{
			Type:    "github.import",
			Payload: map[string]any{"status": status},
		})
	}
}

func (h *WSHandler) handleWSRequest(ctx context.Context, conn *websocket.Conn, clientID string, req WSRequest) {
	switch req.Type {
	case "ping":
		h.handleWSPing(conn, clientID, req)
	case "session.message":
		go h.handleSessionMessage(ctx, conn, clientID, req)
	case "session.plan_mode.set":
		h.handleSessionPlanModeSet(ctx, conn, clientID, req)
	case "session.answer_question":
		go h.handleSessionAnswerQuestion(ctx, conn, clientID, req)
	case "session.ready":
		go h.handleSessionReady(clientID, req)
	case "session.cancel":
		h.handleSessionCancel(ctx, conn, clientID, req)
	case "session.queue.remove":
		h.handleSessionQueueRemove(ctx, conn, clientID, req)
	case "session.queue.update":
		h.handleSessionQueueUpdate(ctx, conn, clientID, req)
	case "session.queue.send_now":
		h.handleSessionQueueSendNow(ctx, conn, clientID, req)
	default:
		h.sendWSError(conn, clientID, req.ID, "method_not_found", "method not found")
	}
}

func (h *WSHandler) handleSessionAnswerQuestion(ctx context.Context, conn *websocket.Conn, clientID string, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	agentName := getString(req.Payload, "agent")
	toolUseID := getString(req.Payload, "tool_use_id")
	if key == "" || toolUseID == "" {
		h.sendWSError(conn, clientID, req.ID, "invalid_request", "session_key and tool_use_id required")
		return
	}
	answers := parseStringMap(req.Payload["answers"])
	if len(answers) == 0 {
		h.sendWSError(conn, clientID, req.ID, "invalid_request", "answers required")
		return
	}
	uc := &usecase.Service{Registry: h.AppContext}
	if err := uc.AnswerQuestion(ctx, usecase.AnswerQuestionInput{
		RootID:     rootID,
		SessionKey: key,
		Agent:      agentName,
		ToolUseID:  toolUseID,
		Answers:    answers,
	}); err != nil {
		h.sendWSError(conn, clientID, req.ID, "session.answer_question_failed", err.Error())
		return
	}
	_ = h.writeWSJSON(clientID, conn, WSResponse{
		ID:      req.ID,
		Type:    "session.answer_question.accepted",
		Payload: map[string]any{"root_id": rootID, "session_key": key, "tool_use_id": toolUseID},
	})
}

func (h *WSHandler) handleWSPing(conn *websocket.Conn, clientID string, req WSRequest) {
	resp := WSResponse{
		ID:      req.ID,
		Type:    "pong",
		Payload: map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano)},
	}
	_ = h.writeWSJSON(clientID, conn, resp)
}

func (h *WSHandler) handleSessionMessage(ctx context.Context, conn *websocket.Conn, clientID string, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	requestID := strings.TrimSpace(req.ID)
	content := getString(req.Payload, "content")
	planRequested, strippedContent := parsePlanMessage(content)
	if planRequested {
		content = strippedContent
	}
	sessionType := getString(req.Payload, "type")
	agentName := getString(req.Payload, "agent")
	model := getString(req.Payload, "model")
	agentMode := getString(req.Payload, "agent_mode")
	effort := getString(req.Payload, "effort")
	fastService := normalizeFastServiceValue(getString(req.Payload, "fast_service"))
	shell := getString(req.Payload, "shell")
	terminalCols := getInt(req.Payload, "terminal_cols")
	if content == "" || sessionType == "" || (agentName == "" && sessionType != session.TypeCommand) {
		h.sendWSError(conn, clientID, req.ID, "invalid_request", "content, type and agent required")
		return
	}

	uc := &usecase.Service{Registry: h.AppContext}
	streamHub := h.AppContext.GetSessionStreamHub()
	if requestID != "" {
		if !h.reserveClientRequest(requestID) {
			h.sendWSAccepted(conn, clientID, requestID, rootID, key)
			return
		}
	}
	sessionName := ""
	if key == "" {
		sessionName = usecase.BuildFallbackSessionName(content)
		created, err := uc.CreateSession(ctx, usecase.CreateSessionInput{
			RootID: rootID,
			Input: session.CreateInput{
				Type:     sessionType,
				Agent:    agentName,
				Model:    model,
				Shell:    shell,
				PlanMode: planRequested,
				Name:     sessionName,
			},
		})
		if err != nil {
			h.sendWSError(conn, clientID, req.ID, "session.create_failed", err.Error())
			return
		}
		key = created.Key
		h.broadcastSessionMetaUpdated(rootID, created)
		if sessionType != session.TypeCommand {
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
				h.broadcastSessionMetaUpdated(rootID, updated)
			}(rootID, key, agentName, content)
		}
	} else if current, err := uc.GetSession(ctx, usecase.GetSessionInput{RootID: rootID, Key: key}); err == nil && current != nil {
		sessionName = current.Name
		if planRequested && !current.PlanMode {
			if manager, managerErr := h.AppContext.GetSessionManager(rootID); managerErr == nil {
				if updateErr := manager.UpdatePlanMode(ctx, current, true); updateErr != nil {
					h.sendWSError(conn, clientID, req.ID, "session.plan_mode_failed", updateErr.Error())
					return
				}
				h.switchSessionRuntimePlanMode(ctx, key, current, true)
				updated, getErr := manager.Get(ctx, key, 0)
				if getErr == nil && updated != nil {
					current = updated
					h.broadcastSessionMetaUpdated(rootID, updated)
				}
			} else {
				h.sendWSError(conn, clientID, req.ID, "session.plan_mode_failed", managerErr.Error())
				return
			}
		}
	}
	if requestID != "" {
		h.sendWSAccepted(conn, clientID, requestID, rootID, key)
	}
	if h.AppContext != nil {
		streamHub.BindSessionClient(key, clientID)
	}
	clientCtx := parseClientContext(req.Payload, rootID)
	userMessage := PendingUserMessage{
		Agent:       agentName,
		Model:       model,
		Mode:        agentMode,
		Effort:      effort,
		FastService: fastService,
		Content:     content,
		Timestamp:   time.Now().UTC(),
	}
	job := sessionMessageJob{
		RootID:          rootID,
		Key:             key,
		RequestID:       requestID,
		SessionType:     sessionType,
		SessionName:     sessionName,
		Shell:           shell,
		TerminalCols:    terminalCols,
		User:            userMessage,
		ClientCtx:       clientCtx,
		ExcludeClientID: clientID,
	}
	if streamHub.IsSessionReplying(key) && sessionType != session.TypeCommand {
		queue := streamHub.EnqueueSessionMessage(rootID, key, sessionName, QueuedUserMessage{
			ID:                 requestID,
			PendingUserMessage: userMessage,
			ClientCtx:          clientCtx,
		})
		streamHub.BroadcastSessionQueueUpdated(rootID, key, queue)
		log.Printf("[ws] session.queue.enqueue root=%s session=%s request=%s queue=%d", rootID, key, requestID, len(queue))
		return
	}
	if queue, changed := streamHub.UnfreezeQueuedSessionMessages(key); changed {
		streamHub.BroadcastSessionQueueUpdated(rootID, key, queue)
	}
	h.runSessionMessage(job)
}

func (h *WSHandler) handleSessionPlanModeSet(ctx context.Context, conn *websocket.Conn, clientID string, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	requestID := strings.TrimSpace(req.ID)
	enabled := getBool(req.Payload, "enabled")
	if rootID == "" || key == "" {
		h.sendWSError(conn, clientID, req.ID, "invalid_request", "root_id and session_key required")
		return
	}
	manager, err := h.AppContext.GetSessionManager(rootID)
	if err != nil {
		h.sendWSError(conn, clientID, req.ID, "session.plan_mode_failed", err.Error())
		return
	}
	current, err := manager.Get(ctx, key, 0)
	if err != nil {
		h.sendWSError(conn, clientID, req.ID, "session.plan_mode_failed", err.Error())
		return
	}
	previous := current.PlanMode
	if err := manager.UpdatePlanMode(ctx, current, enabled); err != nil {
		h.sendWSError(conn, clientID, req.ID, "session.plan_mode_failed", err.Error())
		return
	}
	if previous != enabled {
		h.switchSessionRuntimePlanMode(ctx, key, current, enabled)
	}
	updated, err := manager.Get(ctx, key, 0)
	if err != nil {
		h.sendWSError(conn, clientID, req.ID, "session.plan_mode_failed", err.Error())
		return
	}
	h.sendWSAccepted(conn, clientID, requestID, rootID, key)
	h.broadcastSessionMetaUpdated(rootID, updated)
	_ = h.writeWSJSON(clientID, conn, buildSessionDoneResponse(rootID, key, requestID))
}

func wsAgentPoolSessionKey(sessionKey, agentName string) string {
	sessionKey = strings.TrimSpace(sessionKey)
	if sessionKey == "" {
		return ""
	}
	agentName = strings.TrimSpace(agentName)
	if agentName == "" {
		return sessionKey
	}
	return strings.ToLower(agentName) + "-" + sessionKey
}

func (h *WSHandler) switchSessionRuntimePlanMode(ctx context.Context, key string, current *session.Session, enabled bool) {
	if h == nil || h.AppContext == nil || current == nil {
		return
	}
	pool := h.AppContext.GetAgentPool()
	if pool == nil {
		return
	}
	agentName := session.InferAgentFromSession(current)
	if runtime, ok := pool.Get(wsAgentPoolSessionKey(key, agentName)); ok {
		if err := runtime.SetPlanMode(ctx, enabled); err != nil {
			log.Printf("[session/plan] runtime.switch.error session=%s agent=%s plan_mode=%t err=%v", key, agentName, enabled, err)
		}
	}
}

func (h *WSHandler) runSessionMessage(job sessionMessageJob) {
	rootID := job.RootID
	key := job.Key
	requestID := strings.TrimSpace(job.RequestID)
	uc := &usecase.Service{Registry: h.AppContext}
	streamHub := h.AppContext.GetSessionStreamHub()
	msgCtx, cancel := h.sessionMessageContext()
	defer cancel()
	updateTracker := newTurnUpdateTracker()
	subTrackers := map[string]*turnUpdateTracker{}
	var subTrackersMu sync.Mutex
	subTrackerFor := func(sessionKey string) *turnUpdateTracker {
		subTrackersMu.Lock()
		defer subTrackersMu.Unlock()
		tracker := subTrackers[sessionKey]
		if tracker == nil {
			tracker = newTurnUpdateTracker()
			subTrackers[sessionKey] = tracker
		}
		return tracker
	}

	err := uc.SendMessage(msgCtx, usecase.SendMessageInput{
		RootID:       rootID,
		Key:          key,
		Agent:        job.User.Agent,
		Model:        job.User.Model,
		Mode:         job.User.Mode,
		Effort:       job.User.Effort,
		FastService:  job.User.FastService,
		Shell:        job.Shell,
		TerminalCols: job.TerminalCols,
		Content:      job.User.Content,
		ClientCtx:    job.ClientCtx,
		OnStart: func() {
			streamHub.BroadcastSessionUserMessage(rootID, key, job.SessionType, job.SessionName, job.User.Agent, job.User.Model, job.User.Mode, job.User.Effort, job.User.FastService, job.User.Content, job.ExcludeClientID, job.Queued)
		},
		OnUpdate: func(update agenttypes.Event) {
			updateTracker.Begin()
			defer updateTracker.End()
			if updateToEvent(update) == nil {
				return
			}
			h.AppContext.BroadcastSessionUpdate(rootID, key, update)
		},
		OnSubSessionCreated: func(created *session.Session) {
			h.broadcastSessionMetaUpdated(rootID, created)
			if created != nil {
				streamHub.SetPendingReply(rootID, created.Key, created.Name)
			}
		},
		OnSubSessionUpdate: func(sessionKey string, update agenttypes.Event) {
			tracker := subTrackerFor(sessionKey)
			tracker.Begin()
			if updateToEvent(update) == nil {
				tracker.End()
				return
			}
			h.AppContext.BroadcastSessionUpdate(rootID, sessionKey, update)
			if update.Type == agenttypes.EventTypeMessageDone {
				tracker.End()
				if ok := tracker.WaitIdle(msgCtx, sessionDoneSettleWindow, sessionDoneMaxWait); !ok {
					log.Printf("[ws] sub-session.done.wait_timeout root=%s session=%s", rootID, sessionKey)
				}
				h.AppContext.BroadcastSessionDone(rootID, sessionKey, "")
				return
			}
			tracker.End()
		},
	})
	if err != nil {
		log.Printf("[ws] session.message.error root=%s session=%s request=%s err=%v", rootID, key, requestID, err)
		errorMessage := normalizeAgentErrorMessage(err)
		event := &StreamEvent{
			Type: "error",
			Data: map[string]string{"message": errorMessage},
		}
		streamHub.BroadcastSessionStream(rootID, key, event)
	}
	if ok := updateTracker.WaitIdle(msgCtx, sessionDoneSettleWindow, sessionDoneMaxWait); !ok {
		log.Printf("[ws] session.done.wait_timeout root=%s session=%s request=%s", rootID, key, requestID)
	}
	log.Printf("[ws] session.done root=%s session=%s request=%s", rootID, key, requestID)
	h.AppContext.BroadcastSessionDone(rootID, key, requestID)
	h.startNextQueuedSessionMessage(rootID, key)
}

func (h *WSHandler) startNextQueuedSessionMessage(rootID, key string) {
	if h == nil || h.AppContext == nil || rootID == "" || key == "" {
		return
	}
	streamHub := h.AppContext.GetSessionStreamHub()
	item, queue, ok := streamHub.PopQueuedSessionMessage(key, "")
	if !ok {
		return
	}
	streamHub.BroadcastSessionQueueUpdated(rootID, key, queue)
	sessionType := session.TypeChat
	sessionName := ""
	shell := ""
	uc := &usecase.Service{Registry: h.AppContext}
	if current, err := uc.GetSession(context.Background(), usecase.GetSessionInput{RootID: rootID, Key: key}); err == nil && current != nil {
		sessionType = current.Type
		sessionName = current.Name
		shell = current.Shell
	}
	go h.runSessionMessage(sessionMessageJob{
		RootID:      rootID,
		Key:         key,
		SessionType: sessionType,
		SessionName: sessionName,
		Shell:       shell,
		User:        item.PendingUserMessage,
		ClientCtx:   item.ClientCtx,
		Queued:      true,
	})
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
	streamHub.ReplayPending(rootID, clientID, key)
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

func (h *WSHandler) handleSessionCancel(ctx context.Context, conn *websocket.Conn, clientID string, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	if rootID == "" || key == "" {
		h.sendWSError(conn, clientID, req.ID, "invalid_request", "root_id and session_key required")
		return
	}
	log.Printf("[ws] session.cancel root=%s session=%s request=%s", rootID, key, req.ID)

	streamHub := h.AppContext.GetSessionStreamHub()
	if queue, ok := streamHub.FreezeQueuedSessionMessages(key); ok {
		log.Printf("[ws] session.queue.freeze root=%s session=%s request=%s", rootID, key, req.ID)
		streamHub.BroadcastSessionQueueUpdated(rootID, key, queue)
	}

	uc := &usecase.Service{Registry: h.AppContext}
	if err := uc.CancelSessionTurn(ctx, usecase.CancelSessionTurnInput{
		RootID: rootID,
		Key:    key,
	}); err != nil {
		if queue, changed := streamHub.UnfreezeQueuedSessionMessages(key); changed {
			streamHub.BroadcastSessionQueueUpdated(rootID, key, queue)
		}
		log.Printf("[ws] session.cancel.error root=%s session=%s request=%s err=%v", rootID, key, req.ID, err)
		h.sendWSError(conn, clientID, req.ID, "session.cancel_failed", err.Error())
		return
	}
}

func (h *WSHandler) handleSessionQueueRemove(_ context.Context, conn *websocket.Conn, clientID string, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	queueID := strings.TrimSpace(getString(req.Payload, "queue_id"))
	if rootID == "" || key == "" || queueID == "" {
		h.sendWSError(conn, clientID, req.ID, "invalid_request", "root_id, session_key and queue_id required")
		return
	}
	streamHub := h.AppContext.GetSessionStreamHub()
	queue := streamHub.RemoveQueuedSessionMessage(key, queueID)
	streamHub.BroadcastSessionQueueUpdated(rootID, key, queue)
	if req.ID != "" {
		h.sendWSAccepted(conn, clientID, req.ID, rootID, key)
	}
}

func (h *WSHandler) handleSessionQueueUpdate(_ context.Context, conn *websocket.Conn, clientID string, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	queueID := strings.TrimSpace(getString(req.Payload, "queue_id"))
	content := getString(req.Payload, "content")
	if rootID == "" || key == "" || queueID == "" || strings.TrimSpace(content) == "" {
		h.sendWSError(conn, clientID, req.ID, "invalid_request", "root_id, session_key, queue_id and content required")
		return
	}
	streamHub := h.AppContext.GetSessionStreamHub()
	queue := streamHub.UpdateQueuedSessionMessage(key, queueID, content)
	streamHub.BroadcastSessionQueueUpdated(rootID, key, queue)
	if req.ID != "" {
		h.sendWSAccepted(conn, clientID, req.ID, rootID, key)
	}
}

func (h *WSHandler) handleSessionQueueSendNow(ctx context.Context, conn *websocket.Conn, clientID string, req WSRequest) {
	rootID := getString(req.Payload, "root_id")
	key := getString(req.Payload, "session_key")
	queueID := strings.TrimSpace(getString(req.Payload, "queue_id"))
	if rootID == "" || key == "" || queueID == "" {
		h.sendWSError(conn, clientID, req.ID, "invalid_request", "root_id, session_key and queue_id required")
		return
	}
	streamHub := h.AppContext.GetSessionStreamHub()
	streamHub.BindSessionClient(key, clientID)
	queue, ok := streamHub.PromoteQueuedSessionMessage(key, queueID)
	if !ok {
		h.sendWSError(conn, clientID, req.ID, "not_found", "queued message not found")
		return
	}
	streamHub.BroadcastSessionQueueUpdated(rootID, key, queue)
	if req.ID != "" {
		h.sendWSAccepted(conn, clientID, req.ID, rootID, key)
	}
	if !streamHub.IsSessionReplying(key) {
		h.startNextQueuedSessionMessage(rootID, key)
		return
	}
	uc := &usecase.Service{Registry: h.AppContext}
	if err := uc.CancelSessionTurn(ctx, usecase.CancelSessionTurnInput{RootID: rootID, Key: key}); err != nil {
		log.Printf("[ws] session.queue.send_now.cancel.error root=%s session=%s request=%s err=%v", rootID, key, req.ID, err)
	}
}

func (h *WSHandler) sendWSError(conn *websocket.Conn, clientID, id, code, message string) {
	resp := WSResponse{
		ID:   id,
		Type: "session.error",
		Error: &WSResponseError{
			Code:    code,
			Message: message,
		},
		Payload: map[string]any{},
	}
	_ = h.writeWSJSON(clientID, conn, resp)
}

func (h *WSHandler) sendE2EEError(conn *websocket.Conn, id, code string) {
	resp := WSResponse{
		ID:   id,
		Type: "e2ee.error",
		Payload: map[string]any{
			"code": code,
		},
	}
	_ = h.writeWSJSON("", conn, resp)
}

func (h *WSHandler) sendWSAccepted(conn *websocket.Conn, clientID, requestID, rootID, sessionKey string) {
	resp := WSResponse{
		ID:   requestID,
		Type: "session.accepted",
		Payload: map[string]any{
			"request_id":  requestID,
			"root_id":     rootID,
			"session_key": sessionKey,
		},
	}
	_ = h.writeWSJSON(clientID, conn, resp)
}

func (h *WSHandler) reserveClientRequest(requestID string) bool {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return true
	}
	h.requestMu.Lock()
	defer h.requestMu.Unlock()
	if h.requests == nil {
		h.requests = make(map[string]time.Time)
	}
	cutoff := time.Now().Add(-24 * time.Hour)
	for id, seenAt := range h.requests {
		if seenAt.Before(cutoff) {
			delete(h.requests, id)
		}
	}
	if _, exists := h.requests[requestID]; exists {
		return false
	}
	h.requests[requestID] = time.Now().UTC()
	return true
}

func (h *WSHandler) writeWSJSON(clientID string, conn *websocket.Conn, resp WSResponse) error {
	if h.AppContext != nil {
		return h.AppContext.GetSessionStreamHub().WriteJSON(clientID, conn, resp)
	}
	return conn.WriteJSON(resp)
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
	case agenttypes.EventTypeTodoUpdate:
		if todo, ok := update.Data.(agenttypes.TodoUpdate); ok {
			return &StreamEvent{Type: "todo_update", Data: todo}
		}
	case agenttypes.EventTypePlanUpdate:
		if plan, ok := update.Data.(agenttypes.PlanUpdate); ok {
			return &StreamEvent{Type: "plan_update", Data: plan}
		}
	case agenttypes.EventTypeCompact:
		if compact, ok := update.Data.(agenttypes.CompactNotice); ok {
			return &StreamEvent{Type: "compact_notice", Data: compact}
		}
	case agenttypes.EventTypeMessageDone:
		if done, ok := update.Data.(agenttypes.MessageDone); ok {
			return &StreamEvent{Type: "message_done", Data: done}
		}
		return &StreamEvent{Type: "message_done", Data: agenttypes.MessageDone{}}
	case agenttypes.EventTypeRecovery:
		if recovery, ok := update.Data.(agenttypes.RecoveryStatus); ok {
			return &StreamEvent{Type: "recovery", Data: recovery}
		}
		return &StreamEvent{Type: "recovery", Data: agenttypes.RecoveryStatus{}}
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

func parsePlanMessage(content string) (bool, string) {
	trimmed := strings.TrimSpace(content)
	lower := strings.ToLower(trimmed)
	if lower == "/plan" {
		return true, ""
	}
	if strings.HasPrefix(lower, "/plan ") {
		return true, strings.TrimSpace(trimmed[len("/plan"):])
	}
	return false, content
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

func getInt(payload map[string]any, key string) int {
	if payload == nil {
		return 0
	}
	value, ok := payload[key]
	if !ok {
		return 0
	}
	switch typed := value.(type) {
	case int:
		return typed
	case float64:
		return int(typed)
	case string:
		parsed := 0
		for _, ch := range strings.TrimSpace(typed) {
			if ch < '0' || ch > '9' {
				return 0
			}
			parsed = parsed*10 + int(ch-'0')
		}
		return parsed
	default:
		return 0
	}
}

func normalizeFastServiceValue(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "on":
		return "on"
	case "off":
		return "off"
	default:
		return ""
	}
}

func getBool(payload map[string]any, key string) bool {
	if payload == nil {
		return false
	}
	value, ok := payload[key]
	if !ok {
		return false
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "1", "true", "yes", "on", "fast":
			return true
		default:
			return false
		}
	default:
		return false
	}
}

func parseStringMap(raw any) map[string]string {
	items, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]string, len(items))
	for key, value := range items {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		switch v := value.(type) {
		case string:
			if trimmed := strings.TrimSpace(v); trimmed != "" {
				out[key] = trimmed
			}
		case []any:
			parts := make([]string, 0, len(v))
			for _, item := range v {
				if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
					parts = append(parts, strings.TrimSpace(text))
				}
			}
			if len(parts) > 0 {
				out[key] = strings.Join(parts, ", ")
			}
		}
	}
	return out
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
