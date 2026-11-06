package api

import (
	"encoding/json"
	"io"
	"net/http"

	"mindfs/server/internal/relay"
)

func (h *HTTPHandler) handleRelayConnectionPreference(w http.ResponseWriter, r *http.Request) {
	if h.AppContext == nil || h.AppContext.GetPreferences() == nil {
		respondError(w, http.StatusServiceUnavailable, errInvalidRequest("preferences not configured"))
		return
	}
	prefs := h.AppContext.GetPreferences()
	if r.Method == http.MethodPut {
		var req struct {
			Mode string `json:"mode"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil || (req.Mode != "auto" && req.Mode != "direct" && req.Mode != "system") {
			respondError(w, http.StatusBadRequest, errInvalidRequest("mode must be auto, direct or system"))
			return
		}
		if err := prefs.UpdateRelayConnectionMode(req.Mode); err != nil {
			respondError(w, http.StatusInternalServerError, err)
			return
		}
		if manager := h.AppContext.GetRelayManager(); manager != nil {
			if isRelayedRequest(r) {
				w.Header().Set(relay.ConnectionModeResponseHeader, prefs.RelayConnectionMode())
			} else {
				manager.SetConnectionMode(prefs.RelayConnectionMode())
			}
		}
	}
	respondJSON(w, http.StatusOK, map[string]any{"mode": prefs.RelayConnectionMode()})
}
