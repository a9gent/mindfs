package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"mindfs/server/internal/webpush"
)

type webPushSubscriptionRequest struct {
	Endpoint string                   `json:"endpoint"`
	Keys     webpush.SubscriptionKeys `json:"keys"`
	Platform string                   `json:"platform"`
}

func (h *HTTPHandler) webPushService() (*webpush.Service, error) {
	if h == nil || h.AppContext == nil || h.AppContext.GetWebPushService() == nil {
		return nil, errServiceUnavailable("web push service not configured")
	}
	return h.AppContext.GetWebPushService(), nil
}

func (h *HTTPHandler) handleWebPushStatus(w http.ResponseWriter, r *http.Request) {
	svc, err := h.webPushService()
	if err != nil {
		respondJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	respondJSON(w, http.StatusOK, svc.Status())
}

func (h *HTTPHandler) handleWebPushSubscriptionSave(w http.ResponseWriter, r *http.Request) {
	svc, err := h.webPushService()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	var req webPushSubscriptionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid web push subscription payload"))
		return
	}
	sub, err := svc.SaveSubscription(webpush.Subscription{
		Endpoint:  strings.TrimSpace(req.Endpoint),
		Keys:      req.Keys,
		UserAgent: strings.TrimSpace(r.UserAgent()),
		Platform:  strings.TrimSpace(req.Platform),
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest(err.Error()))
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"subscription": sub,
	})
}

func (h *HTTPHandler) handleWebPushSubscriptionDelete(w http.ResponseWriter, r *http.Request) {
	svc, err := h.webPushService()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if err := svc.DeleteSubscription(req.Endpoint); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest(err.Error()))
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *HTTPHandler) handleWebPushTest(w http.ResponseWriter, r *http.Request) {
	svc, err := h.webPushService()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	if err := svc.SendTestToEndpoint(r.Context(), req.Endpoint); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest(err.Error()))
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"ok": true})
}
