package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"mindfs/server/internal/scheduled"

	"github.com/go-chi/chi/v5"
)

func (h *HTTPHandler) scheduledService() (*scheduled.Service, error) {
	if h == nil || h.AppContext == nil || h.AppContext.Scheduled == nil {
		return nil, errInvalidRequest("scheduled service not configured")
	}
	return h.AppContext.Scheduled, nil
}

func (h *HTTPHandler) handleScheduledAgentTasksList(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	svc, err := h.scheduledService()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	tasks, err := svc.List(r.Context(), rootID)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"tasks": tasks})
}

func (h *HTTPHandler) handleScheduledAgentTaskCreate(w http.ResponseWriter, r *http.Request) {
	input, err := decodeScheduledAgentTaskInput(r)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	svc, err := h.scheduledService()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	task, err := svc.Create(r.Context(), input)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"task": task})
}

func (h *HTTPHandler) handleScheduledAgentTaskUpdate(w http.ResponseWriter, r *http.Request) {
	input, err := decodeScheduledAgentTaskInput(r)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	input.ID = strings.TrimSpace(chi.URLParam(r, "id"))
	svc, err := h.scheduledService()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	task, err := svc.Update(r.Context(), input)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"task": task})
}

func (h *HTTPHandler) handleScheduledAgentTaskDelete(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	svc, err := h.scheduledService()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	if err := svc.Delete(r.Context(), rootID, id); err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *HTTPHandler) handleScheduledAgentTaskRun(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	svc, err := h.scheduledService()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	task, err := svc.RunNow(r.Context(), rootID, id)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"task": task})
}

func decodeScheduledAgentTaskInput(r *http.Request) (scheduled.SaveInput, error) {
	var input scheduled.SaveInput
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&input); err != nil {
		return scheduled.SaveInput{}, errInvalidRequest("invalid scheduled task payload")
	}
	input.RootID = strings.TrimSpace(input.RootID)
	input.Name = strings.TrimSpace(input.Name)
	input.TaskCron = strings.TrimSpace(input.TaskCron)
	input.Agent = strings.TrimSpace(input.Agent)
	input.Model = strings.TrimSpace(input.Model)
	input.Mode = strings.TrimSpace(input.Mode)
	input.Effort = strings.TrimSpace(input.Effort)
	input.FastService = strings.TrimSpace(input.FastService)
	input.Prompt = strings.TrimSpace(input.Prompt)
	input.NewSessionCron = strings.TrimSpace(input.NewSessionCron)
	return input, nil
}
