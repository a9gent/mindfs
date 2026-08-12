package api

import (
	"encoding/json"
	"net/http"
	"strings"
)

type codexRateLimitResetRequest struct {
	Agent          string `json:"agent"`
	IdempotencyKey string `json:"idempotency_key"`
	CreditID       string `json:"credit_id,omitempty"`
}

func (h *HTTPHandler) handleCodexRateLimitsGet(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.AppContext == nil || h.AppContext.GetAgentPool() == nil {
		respondError(w, http.StatusServiceUnavailable, errInvalidRequest("agent pool not configured"))
		return
	}
	agentName := strings.TrimSpace(r.URL.Query().Get("agent"))
	if agentName == "" {
		agentName = "codex"
	}
	status, err := h.AppContext.GetAgentPool().CodexRateLimits(r.Context(), agentName)
	if err != nil {
		respondError(w, http.StatusBadGateway, errInvalidRequest(err.Error()))
		return
	}
	respondJSON(w, http.StatusOK, status)
}

func (h *HTTPHandler) handleCodexRateLimitReset(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.AppContext == nil || h.AppContext.GetAgentPool() == nil {
		respondError(w, http.StatusServiceUnavailable, errInvalidRequest("agent pool not configured"))
		return
	}
	var req codexRateLimitResetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	if req.Agent = strings.TrimSpace(req.Agent); req.Agent == "" {
		req.Agent = "codex"
	}
	if req.IdempotencyKey = strings.TrimSpace(req.IdempotencyKey); req.IdempotencyKey == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("idempotency_key required"))
		return
	}
	result, err := h.AppContext.GetAgentPool().ConsumeCodexRateLimitReset(
		r.Context(),
		req.Agent,
		req.IdempotencyKey,
		strings.TrimSpace(req.CreditID),
	)
	if err != nil {
		respondError(w, http.StatusBadGateway, errInvalidRequest(err.Error()))
		return
	}
	respondJSON(w, http.StatusOK, result)
}
