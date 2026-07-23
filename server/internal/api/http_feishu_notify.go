package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"mindfs/server/internal/feishunotify"
)

func (h *HTTPHandler) feishuNotifyService() (*feishunotify.Service, error) {
	if h == nil || h.AppContext == nil || h.AppContext.GetFeishuService() == nil {
		return nil, errServiceUnavailable("feishu notify service not configured")
	}
	return h.AppContext.GetFeishuService(), nil
}

func (h *HTTPHandler) handleFeishuNotifyGet(w http.ResponseWriter, r *http.Request) {
	svc, err := h.feishuNotifyService()
	if err != nil {
		// Still return a disabled public shape so the UI can render an editor.
		respondJSON(w, http.StatusOK, feishunotify.PublicConfig{
			Enabled: false,
			Events:  []string{},
			Active:  false,
		})
		return
	}
	respondJSON(w, http.StatusOK, svc.PublicConfig())
}

func (h *HTTPHandler) handleFeishuNotifyPut(w http.ResponseWriter, r *http.Request) {
	svc, err := h.feishuNotifyService()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid feishu notify payload"))
		return
	}
	req := feishunotify.UpdateRequest{}
	if v, ok := raw["enabled"]; ok {
		var enabled bool
		if err := json.Unmarshal(v, &enabled); err != nil {
			respondError(w, http.StatusBadRequest, errInvalidRequest("enabled must be boolean"))
			return
		}
		req.Enabled = &enabled
	}
	if v, ok := raw["webhook_url"]; ok {
		var webhook string
		if err := json.Unmarshal(v, &webhook); err != nil {
			respondError(w, http.StatusBadRequest, errInvalidRequest("webhook_url must be string"))
			return
		}
		webhook = strings.TrimSpace(webhook)
		req.WebhookURL = &webhook
	}
	if v, ok := raw["app_id"]; ok {
		var appID string
		if err := json.Unmarshal(v, &appID); err != nil {
			respondError(w, http.StatusBadRequest, errInvalidRequest("app_id must be string"))
			return
		}
		appID = strings.TrimSpace(appID)
		req.AppID = &appID
	}
	if v, ok := raw["app_secret"]; ok {
		var secret string
		if err := json.Unmarshal(v, &secret); err != nil {
			respondError(w, http.StatusBadRequest, errInvalidRequest("app_secret must be string"))
			return
		}
		// Empty string intentionally clears the stored secret.
		req.AppSecret = &secret
	}
	if v, ok := raw["chat_id"]; ok {
		var chatID string
		if err := json.Unmarshal(v, &chatID); err != nil {
			respondError(w, http.StatusBadRequest, errInvalidRequest("chat_id must be string"))
			return
		}
		chatID = strings.TrimSpace(chatID)
		req.ChatID = &chatID
	}
	if v, ok := raw["events"]; ok {
		var events []string
		if err := json.Unmarshal(v, &events); err != nil {
			respondError(w, http.StatusBadRequest, errInvalidRequest("events must be string array"))
			return
		}
		req.Events = events
		req.EventsSet = true
	}

	out, err := svc.UpdateConfig(req)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err)
		return
	}
	respondJSON(w, http.StatusOK, out)
}

func (h *HTTPHandler) handleFeishuNotifyTest(w http.ResponseWriter, r *http.Request) {
	svc, err := h.feishuNotifyService()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	if err := svc.SendTest(r.Context()); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest(err.Error()))
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"ok": true})
}
