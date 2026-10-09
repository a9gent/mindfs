package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"mindfs/server/internal/api/usecase"
)

func (h *StreamHub) beginSessionEdit(key string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.edits[key] {
		return false
	}
	if h.edits == nil {
		h.edits = map[string]bool{}
	}
	h.edits[key] = true
	state := h.ensurePendingSessionLocked(key)
	state.QueueFrozen = true
	return true
}

func (h *StreamHub) sessionEditIdle(key string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	state := h.pendingSessions[key]
	return h.jobs[key] == 0 && (state == nil || !state.Active)
}

func (h *StreamHub) finishSessionEdit(key string, start bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.edits, key)
	state := h.ensurePendingSessionLocked(key)
	if start {
		state.Active = true
	}
	state.QueueFrozen = true
	delete(h.completed, key)
	h.clearReplayStatesForSessionLocked(key)
}

func (h *StreamHub) trackSessionJob(key string, delta int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.jobs == nil {
		h.jobs = map[string]int{}
	}
	h.jobs[key] += delta
	if h.jobs[key] == 0 {
		delete(h.jobs, key)
	}
}

func (h *HTTPHandler) handleSessionEdit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootID            string    `json:"root_id"`
		Key               string    `json:"session_key"`
		Seq               int       `json:"seq"`
		Content           string    `json:"content"`
		OriginalContent   string    `json:"original_content"`
		OriginalTimestamp time.Time `json:"original_timestamp"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		respondError(w, 400, err)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		respondError(w, 400, errors.New("one JSON object required"))
		return
	}
	if strings.TrimSpace(req.Content) == "" || req.RootID == "" || req.Key == "" || req.Seq < 0 || req.OriginalTimestamp.IsZero() {
		respondError(w, 400, errors.New("session, message and original timestamp required"))
		return
	}
	uc := h.service()
	hub := h.AppContext.GetSessionStreamHub()
	in := usecase.EditSessionMessageInput{RootID: req.RootID, Key: req.Key, Seq: req.Seq, OriginalContent: req.OriginalContent, OriginalTimestamp: req.OriginalTimestamp}
	manager, err := h.AppContext.GetSessionManager(req.RootID)
	if err != nil {
		respondError(w, http.StatusNotFound, err)
		return
	}
	current, err := manager.EditSnapshot(req.Key)
	if err == nil {
		if pending := hub.GetPendingUserExchange(req.Key); pending != nil {
			if pending.Content != req.OriginalContent || !pending.Timestamp.Equal(req.OriginalTimestamp) {
				err = errors.New("only the latest user message can be edited")
			} else {
				// The pending user may not be persisted yet. Its immutable
				// timestamp and text will identify it after cancellation drains.
				in.Seq = 0
			}
		} else {
			_, err = usecase.ValidateEditTarget(current, in)
		}
	}
	if err != nil {
		respondError(w, http.StatusConflict, err)
		return
	}
	if !hub.beginSessionEdit(req.Key) {
		respondError(w, 409, errors.New("another edit is in progress"))
		return
	}
	_, queue, _ := hub.queueSnapshot(req.Key)
	hub.BroadcastSessionQueueUpdated(req.RootID, req.Key, queue)
	started := false
	defer func() {
		if !started {
			hub.finishSessionEdit(req.Key, false)
		}
	}()
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	// Recheck while waiting: the reserved original job may not have registered
	// its active turn yet when the edit arrives.
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for !hub.sessionEditIdle(req.Key) || usecase.SessionTurnActive(req.RootID, req.Key) {
		if err = usecase.InterruptSessionForEdit(req.RootID, req.Key); err != nil {
			respondError(w, 409, err)
			return
		}
		select {
		case <-ctx.Done():
			respondError(w, 409, errors.New("could not stop the current reply; retry editing"))
			return
		case <-ticker.C:
		}
	}
	updated, target, err := uc.PrepareEditedSession(ctx, in)
	if err != nil {
		respondError(w, 409, err)
		return
	}
	// This reset precedes all replacement turn events on every websocket.
	hub.BroadcastAll(WSResponse{Type: "session.truncated", Payload: map[string]any{
		"root_id": req.RootID, "session_key": req.Key,
		"from_seq": target.Seq, "previous_revision": updated.HistoryRevision - 1,
		"history_revision": updated.HistoryRevision,
	}})
	now := time.Now().UTC()
	requestID := "edit-" + now.Format("20060102150405.000000000")
	hub.finishSessionEdit(req.Key, true)
	started = true
	ws := &WSHandler{AppContext: h.AppContext}
	go ws.runSessionMessage(sessionMessageJob{
		RootID: req.RootID, Key: req.Key, RequestID: requestID,
		RuntimeRootPath: sessionRuntimeRootPath(updated), SessionType: updated.Type, SessionName: updated.Name,
		ClientCtx: parseClientContext(nil, req.RootID),
		User:      PendingUserMessage{Agent: target.Agent, Model: target.Model, Mode: target.Mode, Effort: target.Effort, FastService: target.FastService, PlanMode: updated.PlanMode, Content: req.Content, Timestamp: now},
	})
	respondJSON(w, http.StatusAccepted, map[string]any{"session_key": req.Key, "request_id": requestID})
}
