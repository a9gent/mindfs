package api

import (
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"io"
	"mindfs/server/internal/kanban"
	"net/http"
)

func (h *HTTPHandler) handleTaskGroups(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		items, e := svc.ListGroups(r.Context(), r.URL.Query().Get("root"))
		if e != nil {
			respondError(w, 400, e)
			return
		}
		respondJSON(w, 200, map[string]any{"items": items})
		return
	}
	var g kanban.TaskGroup
	if e := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&g); e != nil {
		respondError(w, 400, e)
		return
	}
	out, e := svc.CreateGroup(r.Context(), g)
	if e != nil {
		respondError(w, 409, e)
		return
	}
	respondJSON(w, 200, out)
}
func (h *HTTPHandler) handleTaskGroup(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	g, e := svc.GroupGraph(r.Context(), r.URL.Query().Get("root"), id)
	if e != nil {
		respondError(w, 400, e)
		return
	}
	if view := r.URL.Query().Get("view"); view == "context" {
		respondJSON(w, 200, map[string]any{"group_id": g.Group.ID, "project_context": g.Group.ProjectContext, "plan_version": g.Group.PlanVersion})
		return
	} else if view == "messages" {
		respondJSON(w, 200, map[string]any{"events": g.Messages})
		return
	}
	respondJSON(w, 200, g)
}

func (h *HTTPHandler) handleTaskGroupAction(w http.ResponseWriter, r *http.Request) {
	action := chi.URLParam(r, "operation")
	if action == "approve-plan" && r.Header.Get(localCLIHeaderName) != "" {
		respondError(w, 403, errInvalidRequest("first publication requires user approval"))
		return
	}
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	var req struct {
		RootID string `json:"root_id"`
		kanban.ManagedInput
		Tasks []kanban.ChildPlanItem `json:"tasks"`
	}
	if e := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); e != nil {
		respondError(w, 400, e)
		return
	}
	id := chi.URLParam(r, "id")
	if action == "plan" {
		if _, e := svc.GroupGraph(r.Context(), req.RootID, id); e != nil {
			respondError(w, 400, e)
			return
		}
		if _, e := svc.CreateGroupTasks(r.Context(), req.RootID, id, req.Tasks); e != nil {
			respondError(w, 409, e)
			return
		}
		g, e := svc.GroupGraph(r.Context(), req.RootID, id)
		if e != nil {
			respondError(w, 400, e)
			return
		}
		respondJSON(w, 200, g)
		return
	}
	g, e := svc.GroupAction(r.Context(), req.RootID, id, action, req.ManagedInput)
	if e != nil {
		respondError(w, 409, e)
		return
	}
	respondJSON(w, 200, g)
}

func (h *HTTPHandler) handleTaskGroupContext(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	var req struct {
		RootID         string  `json:"root_id"`
		ProjectContext *string `json:"project_context"`
		PlanVersion    *int    `json:"plan_version"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
		respondError(w, 400, err)
		return
	}
	if req.ProjectContext == nil || req.PlanVersion == nil {
		respondError(w, 400, errInvalidRequest("project_context and plan_version required"))
		return
	}
	g, err := svc.UpdateGroupContext(r.Context(), req.RootID, chi.URLParam(r, "id"), *req.ProjectContext, *req.PlanVersion)
	if err != nil {
		respondError(w, 409, err)
		return
	}
	respondJSON(w, 200, g)
}
