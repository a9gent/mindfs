package kanban

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ChildPlanItem permits forward references within a single atomic creation request.
// Ref is local to this request; external dependencies continue to use task IDs.
type ChildPlanItem struct {
	Ref string `json:"ref"`
	CreateTaskInput
}

func (s *Service) CreateGroupTasks(ctx context.Context, root, groupID string, items []ChildPlanItem) (GroupGraph, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	store, e := s.taskStore(root)
	if e != nil {
		return GroupGraph{}, e
	}
	g, e := s.groupGraph(ctx, store, groupID)
	if e != nil {
		return g, e
	}
	if g.Group.Status == "cancelled" {
		return g, errors.New("group is terminal")
	}
	if len(items) == 0 || len(items) > 100 {
		return g, errors.New("plan requires 1–100 child tasks")
	}
	refs := map[string]string{}
	ids := make([]string, len(items))
	for i, item := range items {
		if item.Ref == "" {
			return g, errors.New("each task requires a local ref")
		}
		if refs[item.Ref] != "" {
			return g, errors.New("duplicate local ref")
		}
		ids[i] = newID("task")
		refs[item.Ref] = ids[i]
	}
	tasks := make([]Task, len(items))
	runs := make([]StageRun, len(items))
	events := make([]TaskEvent, len(items))
	dependencies := make([][]string, len(items))
	for i, item := range items {
		in := item.CreateTaskInput
		if strings.TrimSpace(in.Input) == "" {
			return g, errors.New("child input required")
		}
		in.RootID = root
		in.GroupID = groupID
		tmpl, e := s.creationTemplate(ctx, store, in)
		if e != nil {
			return g, e
		}
		deps := append([]string{}, in.DependsOn...)
		for j, dep := range deps {
			if id := refs[dep]; id != "" {
				deps[j] = id
			}
		}
		dependencies[i] = deps
		g.Edges[ids[i]] = deps
		now := time.Now().UTC()
		mode, branch := normalizeTaskWorktreeBranch(in.WorktreeBranchMode, in.WorktreeBranch)
		tasks[i] = Task{ID: ids[i], RootID: root, TaskTemplateID: tmpl.ID, TaskTemplateName: tmpl.Name, Agent: in.Agent, Model: createModelOverride(in), GroupID: in.GroupID, CreateWorktree: in.CreateWorktree, WorktreeBranchMode: mode, WorktreeBranch: branch, Status: StatusPending, CreatedAt: now, UpdatedAt: now, Labels: []string{}}
		runs[i] = StageRun{ID: newID("run"), TaskID: ids[i], StageIndex: 0, StageName: tmpl.Stages[0].Snapshot.Name, Role: RoleUser, Status: StageStatusWaitingUser, Input: in.Input, CreatedAt: now, UpdatedAt: now}
		events[i] = TaskEvent{ID: newID("event"), TaskID: ids[i], Type: "task_created", Payload: eventPayload(map[string]any{"input": in.Input}), CreatedAt: now}
	}
	if e = ValidateDAG(g.Edges); e != nil {
		return g, e
	}
	tx, e := store.db.BeginTx(ctx, nil)
	if e != nil {
		return g, e
	}
	defer tx.Rollback()
	var number int
	if e = tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(task_number),0) FROM tasks`).Scan(&number); e != nil {
		return g, e
	}
	for i := range tasks {
		number++
		tasks[i].TaskNumber = number
		if e = insertTask(ctx, tx, tasks[i]); e != nil {
			return g, fmt.Errorf("create %s: %w", items[i].Ref, e)
		}
		if e = insertStageRun(ctx, tx, runs[i]); e != nil {
			return g, e
		}
		if e = insertTaskEvent(ctx, tx, events[i]); e != nil {
			return g, e
		}
		if e = replaceDependencies(ctx, tx, tasks[i].ID, dependencies[i]); e != nil {
			return g, e
		}
	}
	if e = appendToGroup(ctx, tx, groupID); e != nil {
		return g, e
	}
	if e = tx.Commit(); e != nil {
		return g, e
	}
	for _, t := range tasks {
		s.changed(ctx, store, t.ID)
	}
	s.taskGroupChanged(ctx, store, groupID)
	return s.groupGraph(ctx, store, groupID)
}
