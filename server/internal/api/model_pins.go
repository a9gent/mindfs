package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

func (h *HTTPHandler) handleModelPinsPut(w http.ResponseWriter, r *http.Request) {
	if h.AppContext == nil || h.AppContext.GetPreferences() == nil {
		respondError(w, http.StatusServiceUnavailable, errInvalidRequest("preferences not configured"))
		return
	}
	var req struct {
		Agent  string `json:"agent"`
		Model  string `json:"model"`
		Pinned *bool  `json:"pinned"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid request"))
		return
	}
	req.Agent, req.Model = strings.TrimSpace(req.Agent), strings.TrimSpace(req.Model)
	if req.Agent == "" || len(req.Agent) > 256 || req.Model == "" || len(req.Model) > 4096 || req.Pinned == nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("agent, model and pinned are required"))
		return
	}
	models, err := h.AppContext.GetPreferences().SetModelPinned(req.Agent, req.Model, *req.Pinned)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"models": models})
}
