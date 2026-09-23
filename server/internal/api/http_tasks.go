package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"mindfs/server/internal/kanban"

	"github.com/go-chi/chi/v5"
)

func (h *HTTPHandler) kanbanService(w http.ResponseWriter) (*kanban.Service, bool) {
	if h == nil || h.AppContext == nil {
		respondError(w, http.StatusServiceUnavailable, errInvalidRequest("app context unavailable"))
		return nil, false
	}
	svc, err := h.AppContext.GetKanbanService()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return nil, false
	}
	return svc, true
}

func (h *HTTPHandler) handleTaskStageTemplatesList(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	items, err := svc.ListStageTemplates(r.Context())
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *HTTPHandler) handleTaskStageTemplateSave(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	var req kanban.StageTemplate
	if err := json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	item, err := svc.SaveStageTemplate(r.Context(), req)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, item)
}

func (h *HTTPHandler) handleTaskStageTemplateDelete(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	if err := svc.DeleteStageTemplate(r.Context(), chi.URLParam(r, "id")); err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) handleTaskTemplatesList(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	items, err := svc.ListTaskTemplates(r.Context())
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *HTTPHandler) handleTaskTemplateSave(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	var req kanban.TaskTemplate
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	if id := strings.TrimSpace(chi.URLParam(r, "id")); id != "" {
		req.ID = id
	}
	item, err := svc.SaveTaskTemplate(r.Context(), req)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, item)
}

func (h *HTTPHandler) handleTaskTemplateDelete(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	if err := svc.DeleteTaskTemplate(r.Context(), chi.URLParam(r, "id")); err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) handleKanbanTasksList(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	rootID := r.URL.Query().Get("root")
	opts := kanban.ListTasksOptions{
		TemplateID: r.URL.Query().Get("template_id"),
		Status:     r.URL.Query().Get("status"),
		After:      r.URL.Query().Get("after"),
		Before:     r.URL.Query().Get("before"),
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 0 {
			respondError(w, http.StatusBadRequest, errInvalidRequest("invalid limit"))
			return
		}
		opts.Limit = limit
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("task_number")); raw != "" {
		taskNumber, err := strconv.Atoi(strings.TrimPrefix(raw, "#"))
		if err != nil || taskNumber <= 0 {
			respondError(w, http.StatusBadRequest, errInvalidRequest("invalid task_number"))
			return
		}
		opts.TaskNumber = taskNumber
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("stage")); raw != "" {
		stage, err := strconv.Atoi(raw)
		if err != nil {
			respondError(w, http.StatusBadRequest, errInvalidRequest("invalid stage"))
			return
		}
		opts.Stage = stage
		opts.HasStage = true
	}
	summary := r.URL.Query().Get("summary") == "1"
	if summary {
		opts.CreatedDesc = true
		opts.Limit = 21 // One extra row determines whether another page exists.
		if raw := r.URL.Query().Get("cursor"); raw != "" {
			cursor, err := strconv.Atoi(raw)
			if err != nil || cursor <= 0 {
				respondError(w, http.StatusBadRequest, errInvalidRequest("cursor must be a positive task number"))
				return
			}
			opts.CursorTaskNumber = cursor
		}
	}
	items, err := svc.ListTaskDetails(r.Context(), rootID, opts)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	if summary {
		nextCursor := ""
		if len(items) > 20 {
			items = items[:20]
			last := items[len(items)-1].Task
			nextCursor = strconv.Itoa(last.TaskNumber)
		}
		summaries := []map[string]any{}
		for _, d := range items {
			input := ""
			for _, run := range d.StageRuns {
				if run.StageIndex == 0 {
					input = run.Input
					break
				}
			}
			runes := []rune(input)
			if len(runes) > 240 {
				input = string(runes[:240]) + "…"
			}
			agentName, model := "", ""
			tmpl, _ := svc.TaskExecutionTemplate(d.Task)
			for _, stage := range tmpl.Stages {
				if stage.Snapshot.Role == kanban.RoleAgent {
					agentName = stage.Snapshot.Agent
					model = stage.Snapshot.Model
					break
				}
			}
			summaries = append(summaries, map[string]any{"id": d.Task.ID, "task_number": d.Task.TaskNumber, "group_id": d.Task.GroupID, "status": d.Task.Status, "published": d.Task.Published, "input_summary": input, "block_reason": d.Task.BlockReason, "depends_on": d.Task.DependsOn, "agent": agentName, "model": model})
		}
		respondJSON(w, http.StatusOK, map[string]any{"items": summaries, "next_cursor": nextCursor})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *HTTPHandler) handleKanbanTaskCreate(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	var req kanban.CreateTaskInput
	decoder := json.NewDecoder(io.LimitReader(r.Body, 4<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	detail, err := svc.CreateTask(r.Context(), req)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	h.broadcastTaskUpdated(req.RootID, detail)
	respondJSON(w, http.StatusOK, detail)
}

func (h *HTTPHandler) handleKanbanTaskInputUpdate(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	var req struct {
		RootID             string `json:"root_id"`
		Input              string `json:"input"`
		CreateWorktree     *bool  `json:"create_worktree"`
		WorktreeBranchMode string `json:"worktree_branch_mode"`
		WorktreeBranch     string `json:"worktree_branch"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	detail, err := svc.UpdateCurrentInput(r.Context(), kanban.UpdateTaskInput{
		RootID:             req.RootID,
		TaskID:             chi.URLParam(r, "id"),
		Input:              req.Input,
		CreateWorktree:     req.CreateWorktree,
		WorktreeBranchMode: req.WorktreeBranchMode,
		WorktreeBranch:     req.WorktreeBranch,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	h.broadcastTaskUpdated(req.RootID, detail)
	respondJSON(w, http.StatusOK, detail)
}

func (h *HTTPHandler) handleKanbanTaskNext(w http.ResponseWriter, r *http.Request) {
	h.handleKanbanTaskMove(w, r, "next")
}

func (h *HTTPHandler) handleKanbanTaskRunNow(w http.ResponseWriter, r *http.Request) {
	h.handleKanbanTaskMove(w, r, "run-now")
}

func (h *HTTPHandler) handleKanbanTaskPrev(w http.ResponseWriter, r *http.Request) {
	h.handleKanbanTaskMove(w, r, "prev")
}

func (h *HTTPHandler) handleKanbanTaskJump(w http.ResponseWriter, r *http.Request) {
	h.handleKanbanTaskMove(w, r, "jump")
}

func (h *HTTPHandler) handleKanbanTaskPause(w http.ResponseWriter, r *http.Request) {
	h.handleKanbanTaskMove(w, r, "pause")
}

func (h *HTTPHandler) handleKanbanTaskResume(w http.ResponseWriter, r *http.Request) {
	h.handleKanbanTaskMove(w, r, "resume")
}

func (h *HTTPHandler) handleKanbanTaskComplete(w http.ResponseWriter, r *http.Request) {
	h.handleKanbanTaskMove(w, r, "complete")
}

func (h *HTTPHandler) handleKanbanTaskCancel(w http.ResponseWriter, r *http.Request) {
	h.handleKanbanTaskMove(w, r, "cancel")
}

func (h *HTTPHandler) handleKanbanTaskFail(w http.ResponseWriter, r *http.Request) {
	h.handleKanbanTaskMove(w, r, "fail")
}

func (h *HTTPHandler) handleKanbanTaskMove(w http.ResponseWriter, r *http.Request, action string) {
	svc, ok := h.kanbanService(w)
	if !ok {
		return
	}
	var req struct {
		RootID     string `json:"root_id"`
		Reason     string `json:"reason"`
		StageIndex int    `json:"stage_index"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req)
	in := kanban.MoveInput{RootID: req.RootID, TaskID: chi.URLParam(r, "id"), Reason: req.Reason, StageIndex: req.StageIndex}
	var (
		detail kanban.TaskDetail
		err    error
	)
	switch action {
	case "next":
		detail, err = svc.Next(r.Context(), in)
	case "run-now":
		detail, err = svc.RunNow(r.Context(), in)
	case "prev":
		detail, err = svc.Prev(r.Context(), in)
	case "jump":
		detail, err = svc.Jump(r.Context(), in)
	case "pause":
		detail, err = svc.Pause(r.Context(), in)
	case "resume":
		detail, err = svc.Resume(r.Context(), in)
	case "complete":
		detail, err = svc.Complete(r.Context(), in)
	case "cancel":
		detail, err = svc.Cancel(r.Context(), in)
	case "fail":
		detail, err = svc.Fail(r.Context(), in)
	default:
		err = errInvalidRequest("unsupported task action")
	}
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	h.broadcastTaskUpdated(req.RootID, detail)
	respondJSON(w, http.StatusOK, detail)
}

func (h *HTTPHandler) broadcastTaskUpdated(rootID string, detail kanban.TaskDetail) {
	if h == nil || h.AppContext == nil {
		return
	}
	h.AppContext.GetSessionStreamHub().BroadcastAll(WSResponse{
		Type: "task.updated",
		Payload: map[string]any{
			"root_id": rootID,
			"task":    detail.Task,
		},
	})
}
