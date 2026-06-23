package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"mindfs/server/internal/relay"
)

func (h *HTTPHandler) handleRelayServicesList(w http.ResponseWriter, _ *http.Request) {
	manager := h.AppContext.GetRelayManager()
	if manager == nil {
		respondError(w, http.StatusServiceUnavailable, errServiceUnavailable("relay manager not configured"))
		return
	}
	if manager.NoRelayer() {
		respondError(w, http.StatusServiceUnavailable, errServiceUnavailable("relay integration is disabled"))
		return
	}
	services, err := manager.ListServices()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	if services == nil {
		services = []relay.LocalService{}
	}
	respondJSON(w, http.StatusOK, services)
}

func (h *HTTPHandler) handleRelayServiceSave(w http.ResponseWriter, r *http.Request) {
	manager := h.AppContext.GetRelayManager()
	if manager == nil {
		respondError(w, http.StatusServiceUnavailable, errServiceUnavailable("relay manager not configured"))
		return
	}
	if manager.NoRelayer() {
		respondError(w, http.StatusServiceUnavailable, errServiceUnavailable("relay integration is disabled"))
		return
	}
	var req relay.LocalService
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json"))
		return
	}
	saved, err := manager.SaveService(r.Context(), req)
	if err != nil {
		respondError(w, httpStatusForRelayServiceError(err), err)
		return
	}
	respondJSON(w, http.StatusOK, saved)
}

func (h *HTTPHandler) handleRelayServiceDelete(w http.ResponseWriter, r *http.Request) {
	manager := h.AppContext.GetRelayManager()
	if manager == nil {
		respondError(w, http.StatusServiceUnavailable, errServiceUnavailable("relay manager not configured"))
		return
	}
	if manager.NoRelayer() {
		respondError(w, http.StatusServiceUnavailable, errServiceUnavailable("relay integration is disabled"))
		return
	}
	slug := relay.NormalizeServiceSlug(strings.TrimPrefix(r.URL.Path, "/api/relay/services/"))
	if !relay.ValidServiceSlug(slug) {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid_service_slug"))
		return
	}
	if err := manager.DeleteService(r.Context(), slug); err != nil {
		respondError(w, httpStatusForRelayServiceError(err), err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func httpStatusForRelayServiceError(err error) int {
	switch err.Error() {
	case "invalid_service_slug", "invalid_local_service_url", "local_service_host_not_allowed":
		return http.StatusBadRequest
	case "relay_not_bound":
		return http.StatusServiceUnavailable
	default:
		return http.StatusServiceUnavailable
	}
}
