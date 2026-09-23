package kanban

import (
	"context"
	"errors"
	"strings"
	"time"
)

func (s *Service) TaskExecutionTemplate(task Task) (TaskTemplate, error) {
	t, err := s.Templates.GetTaskTemplate(task.TaskTemplateID)
	if err != nil {
		return t, err
	}
	return applyTaskOverrides(t, task.Agent, task.Model), nil
}

func applyTaskOverrides(t TaskTemplate, agent string, model *string) TaskTemplate {
	t.Stages = append([]TaskTemplateStage(nil), t.Stages...)
	for i := range t.Stages {
		stage := &t.Stages[i].Snapshot
		if stage.Role != RoleAgent {
			continue
		}
		if agent != "" {
			stage.Agent = agent
			stage.Model, stage.Mode, stage.Effort, stage.FastService = "", "", "", ""
		}
		if model != nil {
			stage.Model = *model
		}
		break
	}
	return t
}

func createModelOverride(in CreateTaskInput) *string {
	if in.Model == "" {
		return nil
	}
	return &in.Model
}

func (s *Service) creationTemplate(ctx context.Context, store *TaskStore, in CreateTaskInput) (TaskTemplate, error) {
	templateID := strings.TrimSpace(in.TaskTemplateID)
	if templateID == "" {
		return TaskTemplate{}, errors.New("task_template_id required; list templates with mindfs -task-templates")
	}
	if in.GroupID != "" {
		g, err := store.getGroup(ctx, in.GroupID)
		if err != nil {
			return TaskTemplate{}, err
		}
		if g.Status == "cancelled" {
			return TaskTemplate{}, errors.New("group is terminal")
		}
	}
	t, err := s.Templates.GetTaskTemplate(templateID)
	if err != nil {
		return TaskTemplate{}, err
	}
	t = applyTaskOverrides(t, in.Agent, createModelOverride(in))

	for _, stage := range t.Stages {
		if stage.Snapshot.Role == RoleAgent {
			if v, ok := s.Runner.(interface{ ValidateTaskAgent(StageTemplate) error }); ok {
				if err := v.ValidateTaskAgent(stage.Snapshot); err != nil {
					return t, err
				}
			}
		}
	}
	return t, nil
}

func (s *Service) CreateTask(ctx context.Context, in CreateTaskInput) (TaskDetail, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	if in.CreateWorktree {
		if in.WorktreeBranchMode != "" && in.WorktreeBranchMode != "new" && in.WorktreeBranchMode != "existing" {
			return TaskDetail{}, errors.New("invalid branch mode")
		}
		if in.WorktreeBranchMode == "existing" && strings.TrimSpace(in.WorktreeBranch) == "" {
			return TaskDetail{}, errors.New("existing branch name required")
		}
	}
	store, err := s.taskStore(in.RootID)
	if err != nil {
		return TaskDetail{}, err
	}

	if in.GroupID != "" && strings.TrimSpace(in.Input) == "" {
		return TaskDetail{}, errors.New("child input required")
	}
	if in.GroupID == "" && len(in.DependsOn) > 0 {
		return TaskDetail{}, errors.New("dependencies require a task group")
	}
	if in.GroupID != "" {
		g, e := s.groupGraph(ctx, store, in.GroupID)
		if e != nil {
			return TaskDetail{}, e
		}
		g.Edges["__new__"] = in.DependsOn
		if e = ValidateDAG(g.Edges); e != nil {
			return TaskDetail{}, e
		}
	}
	detail, err := s.createTask(ctx, in)
	if err == nil {
		s.taskGroupChanged(ctx, store, in.GroupID)
	}
	return detail, err
}

type TaskPatch struct {
	Input              *string   `json:"input"`
	Agent              *string   `json:"agent"`
	Model              *string   `json:"model"`
	CreateWorktree     *bool     `json:"create_worktree"`
	WorktreeBranchMode *string   `json:"worktree_branch_mode"`
	WorktreeBranch     *string   `json:"worktree_branch"`
	DependsOn          *[]string `json:"depends_on"`
	PlanVersion        *int      `json:"plan_version"`
}

func (s *Service) PatchTask(ctx context.Context, root, id string, p TaskPatch) (TaskDetail, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	store, t, tmpl, err := s.loadForMove(ctx, root, id)
	if err != nil {
		return TaskDetail{}, err
	}
	preparationFailed := t.Status == StatusFail && t.CurrentStageIndex == 0 && t.MainSessionKey == "" && !t.SchedulerAdmitted
	if isTerminalStatus(t.Status) && !preparationFailed {
		return TaskDetail{}, errors.New("completed or cancelled task configuration cannot be edited; send execution instructions with -to-task for completed tasks")
	}
	config := p.Input != nil || p.Agent != nil || p.Model != nil || p.CreateWorktree != nil || p.WorktreeBranch != nil || p.WorktreeBranchMode != nil || p.DependsOn != nil
	if config && (t.MainSessionKey != "" || t.SchedulerAdmitted || t.CurrentStageIndex != 0 || (isTerminalStatus(t.Status) && !preparationFailed)) {
		return TaskDetail{}, errors.New("execution configuration can only change before first execution")
	}
	if p.PlanVersion != nil {
		g, err := store.getGroup(ctx, t.GroupID)
		if err != nil {
			return TaskDetail{}, err
		}
		if g.PlanVersion != *p.PlanVersion {
			return TaskDetail{}, errors.New("plan version conflict")
		}
	}
	if p.DependsOn != nil {
		var edges map[string][]string
		if t.GroupID != "" {
			g, e := s.groupGraph(ctx, store, t.GroupID)
			if e != nil {
				return TaskDetail{}, e
			}
			edges = g.Edges
		} else {
			return TaskDetail{}, errors.New("grouped task required")
		}
		edges[id] = *p.DependsOn
		if e := ValidateDAG(edges); e != nil {
			return TaskDetail{}, e
		}
	}
	if p.CreateWorktree != nil {
		if t.WorktreePath != "" {
			return TaskDetail{}, errors.New("worktree already created")
		}
		t.CreateWorktree = *p.CreateWorktree
	}
	if p.WorktreeBranchMode != nil {
		if *p.WorktreeBranchMode != "new" && *p.WorktreeBranchMode != "existing" {
			return TaskDetail{}, errors.New("invalid branch mode")
		}
		t.WorktreeBranchMode = *p.WorktreeBranchMode
	}
	if p.WorktreeBranch != nil {
		t.WorktreeBranch = *p.WorktreeBranch
	}
	if t.CreateWorktree && t.WorktreeBranchMode == "existing" && strings.TrimSpace(t.WorktreeBranch) == "" {
		return TaskDetail{}, errors.New("existing branch name required")
	}
	if p.Agent != nil {
		if strings.TrimSpace(*p.Agent) == "" {
			return TaskDetail{}, errors.New("agent required")
		}
		t.Agent = strings.TrimSpace(*p.Agent)
		t.Model = nil
	}
	if p.Model != nil {
		t.Model = p.Model
	}
	tmpl, err = s.TaskExecutionTemplate(t)
	if err != nil {
		return TaskDetail{}, err
	}

	for _, stage := range tmpl.Stages {
		if stage.Snapshot.Role == RoleAgent {
			if v, ok := s.Runner.(interface{ ValidateTaskAgent(StageTemplate) error }); ok {
				if e := v.ValidateTaskAgent(stage.Snapshot); e != nil {
					return TaskDetail{}, e
				}
			}
		}
	}
	if preparationFailed && config {
		t.Status = StatusWaitingUser
		t.BlockReason = ""
		t.AuxFlags = TaskAuxFlags{}
	}
	if t.GroupID != "" && config {
		t.Published = false
		t.Status = StatusPending
	}
	t.UpdatedAt = time.Now().UTC()
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return TaskDetail{}, err
	}
	defer tx.Rollback()
	if err = updateTaskCore(ctx, tx, t); err != nil {
		return TaskDetail{}, err
	}
	if p.Input != nil {
		_, err = tx.ExecContext(ctx, `UPDATE stage_runs SET input=? WHERE task_id=? AND stage_index=0`, *p.Input, id)
		if err != nil {
			return TaskDetail{}, err
		}
	}
	if p.DependsOn != nil {
		if err = replaceDependencies(ctx, tx, id, *p.DependsOn); err != nil {
			return TaskDetail{}, err
		}
	}
	if err = bumpGroup(ctx, tx, t.GroupID); err != nil {
		return TaskDetail{}, err
	}
	if err = insertTaskEvent(ctx, tx, TaskEvent{ID: newID("event"), TaskID: id, Type: "task_edited", Payload: eventPayload(p), CreatedAt: time.Now().UTC()}); err != nil {
		return TaskDetail{}, err
	}
	if err = tx.Commit(); err != nil {
		return TaskDetail{}, err
	}
	s.taskGroupChanged(ctx, store, t.GroupID)
	return s.changed(ctx, store, id)
}
func (s *Service) changed(ctx context.Context, store *TaskStore, id string) (TaskDetail, error) {
	d, e := store.GetDetail(ctx, id)
	if e == nil && s.Runner != nil {
		s.Runner.TaskUpdated(d.Task.RootID, d)
	}
	return d, e
}

func (s *Service) DeleteTask(ctx context.Context, root, id string) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	store, e := s.taskStore(root)
	if e != nil {
		return e
	}
	t, e := store.GetTask(ctx, id)
	if e != nil {
		return e
	}
	if t.Published || t.MainSessionKey != "" || t.SchedulerAdmitted || t.WorktreePath != "" {
		return errors.New("only unexecuted unpublished tasks without a worktree can be deleted")
	}
	var n int
	if e = store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM task_dependencies WHERE depends_on=?`, id).Scan(&n); e != nil {
		return e
	}
	if n > 0 {
		return errors.New("task is referenced by other tasks")
	}
	tx, e := store.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	for _, q := range []string{`DELETE FROM task_dependencies WHERE task_id=?`, `DELETE FROM task_events WHERE task_id=?`, `DELETE FROM stage_runs WHERE task_id=?`, `DELETE FROM tasks WHERE id=?`} {
		if _, e = tx.ExecContext(ctx, q, id); e != nil {
			return e
		}
	}
	if e = bumpGroup(ctx, tx, t.GroupID); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	s.taskGroupChanged(ctx, store, t.GroupID)
	if notifier, ok := s.Runner.(interface{ TaskDeleted(string, string) }); ok {
		notifier.TaskDeleted(root, id)
	}
	return nil
}

func optionalString(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}
