package api

import (
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"io"
	"mindfs/server/internal/kanban"
	"net/http"
)

func (h *HTTPHandler) handleTaskDetail(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	d, e := svc.GetTask(r.Context(), r.URL.Query().Get("root"), chi.URLParam(r, "id"))
	if e != nil {
		respondError(w, 400, e)
		return
	}
	respondJSON(w, 200, d)
}
func (h *HTTPHandler) handleTaskPatch(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	var req struct {
		RootID string `json:"root_id"`
		kanban.TaskPatch
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 4<<20))
	decoder.DisallowUnknownFields()
	if e := decoder.Decode(&req); e != nil {
		respondError(w, 400, e)
		return
	}
	d, e := svc.PatchTask(r.Context(), req.RootID, chi.URLParam(r, "id"), req.TaskPatch)
	if e != nil {
		respondError(w, 409, e)
		return
	}
	respondJSON(w, 200, d)
}
func (h *HTTPHandler) handleTaskOrchestration(w http.ResponseWriter, r *http.Request) {
	switch chi.URLParam(r, "operation") {
	case "to-task", "from-task", "cancel":
	default:
		respondError(w, http.StatusNotFound, errInvalidRequest("unknown task operation"))
		return
	}
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	var req struct {
		RootID string `json:"root_id"`
		kanban.ManagedInput
	}
	if e := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); e != nil {
		respondError(w, 400, e)
		return
	}
	d, e := svc.ManagedAction(r.Context(), req.RootID, chi.URLParam(r, "id"), chi.URLParam(r, "operation"), req.ManagedInput)
	if e != nil {
		respondError(w, 409, e)
		return
	}
	respondJSON(w, 200, d)
}
func (h *HTTPHandler) handleTaskDelete(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	if e := svc.DeleteTask(r.Context(), r.URL.Query().Get("root"), chi.URLParam(r, "id")); e != nil {
		respondError(w, 409, e)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) handleTaskRead(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	d, e := svc.GetTask(r.Context(), r.URL.Query().Get("root"), chi.URLParam(r, "id"))
	if e != nil {
		respondError(w, 400, e)
		return
	}
	switch chi.URLParam(r, "resource") {
	case "context":
		if d.Task.GroupID != "" {
			g, e := svc.GroupGraph(r.Context(), d.Task.RootID, d.Task.GroupID)
			if e != nil {
				respondError(w, 400, e)
				return
			}
			respondJSON(w, 200, map[string]any{"context": g.Group.ProjectContext, "plan_version": g.Group.PlanVersion, "group_id": g.Group.ID, "session_key": g.Group.SessionKey, "depends_on": d.Task.DependsOn})
			return
		}
		respondJSON(w, 200, map[string]any{"context": "", "depends_on": d.Task.DependsOn})
	case "result":
		for i := len(d.StageRuns) - 1; i >= 0; i-- {
			if d.StageRuns[i].Result != "" {
				respondJSON(w, 200, map[string]any{"result": d.StageRuns[i].Result, "status": d.Task.Status, "block_reason": d.Task.BlockReason})
				return
			}
		}
		respondJSON(w, 200, map[string]any{"result": "", "status": d.Task.Status})
	case "messages":
		messages, e := svc.Messages(r.Context(), d.Task.RootID, d.Task.ID)
		if e != nil {
			respondError(w, 400, e)
			return
		}
		respondJSON(w, 200, map[string]any{"events": messages})
	default:
		respondError(w, 404, errInvalidRequest("unknown task resource"))
	}
}
