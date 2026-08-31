package api

import (
	"net/http"
	"time"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/preferences"
)

type agentMemoryResponse struct {
	agent.MemorySnapshot
	IdleHours int `json:"idle_hours"`
}

type agentSessionReleaseResponse struct {
	agentMemoryResponse
	ReleasedSessions int `json:"released_sessions"`
	FailedSessions   int `json:"failed_sessions"`
}

func (h *HTTPHandler) handleAgentMemoryGet(w http.ResponseWriter, _ *http.Request) {
	pool, hours, ok := h.agentMemoryDependencies(w)
	if !ok {
		return
	}
	snapshot := pool.MemorySnapshot(true)
	respondJSON(w, http.StatusOK, agentMemoryResponse{
		MemorySnapshot: snapshot,
		IdleHours:      hours,
	})
}

func (h *HTTPHandler) handleAgentIdleRelease(w http.ResponseWriter, _ *http.Request) {
	pool, hours, ok := h.agentMemoryDependencies(w)
	if !ok {
		return
	}
	result := pool.ReleaseInactiveSessionsDetailed(time.Now())
	snapshot := pool.MemorySnapshot(true)
	respondJSON(w, http.StatusOK, agentSessionReleaseResponse{
		agentMemoryResponse: agentMemoryResponse{
			MemorySnapshot: snapshot,
			IdleHours:      hours,
		},
		ReleasedSessions: result.ReleasedSessions,
		FailedSessions:   result.FailedSessions,
	})
}

func (h *HTTPHandler) agentMemoryDependencies(w http.ResponseWriter) (*agent.Pool, int, bool) {
	if h == nil || h.AppContext == nil || h.AppContext.GetAgentPool() == nil {
		respondError(w, http.StatusServiceUnavailable, errInvalidRequest("agent pool not configured"))
		return nil, 0, false
	}
	hours := preferences.DefaultIdleSessionResourceReleaseHours
	if store := h.AppContext.GetPreferences(); store != nil {
		hours = store.IdleSessionResourceReleaseHours()
	}
	return h.AppContext.GetAgentPool(), hours, true
}
