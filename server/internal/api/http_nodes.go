package api

import (
	"encoding/json"
	"mindfs/server/internal/preferences"
	"net/http"
)

func (h *HTTPHandler) handleLauncherNodes(w http.ResponseWriter, r *http.Request) {
	if h.AppContext == nil || h.AppContext.GetPreferences() == nil {
		respondError(w, http.StatusServiceUnavailable, errInvalidRequest("preferences not configured"))
		return
	}
	store := h.AppContext.GetPreferences()
	if r.Method == http.MethodPut {
		var req struct {
			Nodes []preferences.LauncherNode `json:"nodes"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil || req.Nodes == nil {
			respondError(w, http.StatusBadRequest, errInvalidRequest("nodes array is required"))
			return
		}
		if err := store.UpdateLauncherNodes(req.Nodes); err != nil {
			respondError(w, http.StatusBadRequest, errInvalidRequest(err.Error()))
			return
		}
	}
	respondJSON(w, http.StatusOK, map[string]any{"nodes": store.LauncherNodes()})
}
