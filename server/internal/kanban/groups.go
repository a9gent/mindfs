package kanban

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// TaskGroup owns orchestration state, not an execution task or a hidden session.
type TaskGroup struct {
	ID             string `json:"id"`
	RootID         string `json:"root_id"`
	SessionKey     string `json:"session_key"`
	Title          string `json:"title"`
	ProjectContext string `json:"project_context"`
	Published      bool   `json:"published"`
	PlanVersion    int    `json:"plan_version"`
	Status         string `json:"status"`
	BlockReason    string `json:"block_reason"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
type GroupGraph struct {
	Group          TaskGroup           `json:"group"`
	Tasks          []TaskDetail        `json:"tasks"`
	Edges          map[string][]string `json:"edges"`
	Messages       []TaskEvent         `json:"messages"`
	MessageHistory []GroupMessage      `json:"message_history,omitempty"`
}

type GroupMessage struct {
	From      string    `json:"from"`
	To        string    `json:"to"`
	Message   string    `json:"message"`
	Timestamp time.Time `json:"timestamp"`
}
type GroupRunner interface {
	ValidateGroupSession(context.Context, string, string) error
	GroupSessionBusy(string, string) bool
	RunGroupTurn(context.Context, TaskGroup, string) error
}

const groupColumns = `id,root_id,session_key,title,project_context,published,plan_version,status,block_reason,created_at,updated_at`

func scanGroup(row interface{ Scan(...any) error }) (TaskGroup, error) {
	var g TaskGroup
	var created, updated string
	e := row.Scan(&g.ID, &g.RootID, &g.SessionKey, &g.Title, &g.ProjectContext, &g.Published, &g.PlanVersion, &g.Status, &g.BlockReason, &created, &updated)
	g.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	g.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updated)
	return g, e
}
func (s *TaskStore) getGroup(ctx context.Context, id string) (TaskGroup, error) {
	return scanGroup(s.db.QueryRowContext(ctx, `SELECT `+groupColumns+` FROM task_groups WHERE id=?`, id))
}
func (s *TaskStore) listGroups(ctx context.Context) ([]TaskGroup, error) {
	rows, e := s.db.QueryContext(ctx, `SELECT `+groupColumns+` FROM task_groups ORDER BY created_at,id`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []TaskGroup{}
	for rows.Next() {
		g, e := scanGroup(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, g)
	}
	return out, rows.Err()
}
func saveGroup(ctx context.Context, tx *sql.Tx, g TaskGroup) error {
	_, e := tx.ExecContext(ctx, `INSERT INTO task_groups (`+groupColumns+`) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET published=excluded.published,plan_version=excluded.plan_version,status=excluded.status,block_reason=excluded.block_reason,updated_at=excluded.updated_at`, g.ID, g.RootID, g.SessionKey, g.Title, g.ProjectContext, g.Published, g.PlanVersion, g.Status, g.BlockReason, g.CreatedAt.Format(time.RFC3339Nano), g.UpdatedAt.Format(time.RFC3339Nano))
	return e
}
func (s *Service) ListGroups(ctx context.Context, root string) ([]TaskGroup, error) {
	store, e := s.taskStore(root)
	if e != nil {
		return nil, e
	}
	return store.listGroups(ctx)
}
func (s *Service) CreateGroup(ctx context.Context, g TaskGroup) (TaskGroup, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	store, e := s.taskStore(g.RootID)
	if e != nil {
		return g, e
	}
	if strings.TrimSpace(g.SessionKey) == "" {
		return g, errors.New("parent session_key required")
	}

	runner, ok := s.Runner.(GroupRunner)
	if !ok {
		return g, errors.New("session orchestration runner unavailable")
	}
	if e = runner.ValidateGroupSession(ctx, g.RootID, g.SessionKey); e != nil {
		return g, e
	}
	now := time.Now().UTC()
	g.ID = newID("group")
	g.CreatedAt = now
	g.UpdatedAt = now
	g.Status = "active"
	g.Published = false
	g.PlanVersion = 0
	g.BlockReason = ""
	tx, e := store.db.BeginTx(ctx, nil)
	if e != nil {
		return g, e
	}
	defer tx.Rollback()
	if e = saveGroup(ctx, tx, g); e != nil {
		return g, e
	}
	if e = tx.Commit(); e == nil {
		s.groupChanged(g)
	}
	return g, e
}
func (s *Service) groupGraph(ctx context.Context, store *TaskStore, id string) (GroupGraph, error) {
	g, e := store.getGroup(ctx, id)
	out := GroupGraph{Group: g, Tasks: []TaskDetail{}, Edges: map[string][]string{}}
	if e != nil {
		return out, e
	}
	tasks, e := store.ListTasks(ctx, ListTasksOptions{})
	if e != nil {
		return out, e
	}
	for _, t := range tasks {
		if t.GroupID == id {
			d, e := store.GetDetail(ctx, t.ID)
			if e != nil {
				return out, e
			}
			for i := range d.StageRuns {
				d.StageRuns[i].RenderedPrompt = ""
			}
			d.Events = nil
			out.Tasks = append(out.Tasks, d)
			out.Edges[t.ID] = d.Task.DependsOn
		}
	}
	out.Messages, e = store.Inbox(ctx, id)
	return out, e
}
func (s *Service) GroupGraph(ctx context.Context, root, id string) (GroupGraph, error) {
	store, e := s.taskStore(root)
	if e != nil {
		return GroupGraph{}, e
	}
	graph, e := s.groupGraph(ctx, store, id)
	if e != nil {
		return graph, e
	}
	graph.MessageHistory, e = store.groupMessageHistory(ctx, graph.Group)
	return graph, e
}
func (s *Service) groupChanged(g TaskGroup) {
	if n, ok := s.Runner.(interface{ GroupUpdated(TaskGroup) }); ok {
		n.GroupUpdated(g)
	}
}
func groupAcceptable(graph GroupGraph) error {
	if !graph.Group.Published || len(graph.Tasks) == 0 {
		return errors.New("published nonempty group required")
	}
	for _, d := range graph.Tasks {
		t := d.Task
		if t.Status != StatusCancelled && (!t.Published || t.Status != StatusSuccess || t.BlockReason != "" || t.SchedulerAdmitted) {
			return fmt.Errorf("task #%d is not effectively complete", t.TaskNumber)
		}
	}
	return nil
}
func (s *Service) GroupAction(ctx context.Context, root, id, action string, in ManagedInput) (TaskGroup, error) {
	g, err := s.groupAction(ctx, root, id, action, in)
	if err == nil && action == "cancel" {
		graph, e := s.GroupGraph(ctx, root, id)
		if e != nil {
			return g, e
		}
		for _, d := range graph.Tasks {
			if !isTerminalStatus(d.Task.Status) {
				if _, e = s.ManagedAction(ctx, root, d.Task.ID, "cancel", ManagedInput{Message: in.Message}); e != nil {
					return g, e
				}
			}
		}
	}
	return g, err
}
func (s *Service) groupAction(ctx context.Context, root, id, action string, in ManagedInput) (TaskGroup, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	store, e := s.taskStore(root)
	if e != nil {
		return TaskGroup{}, e
	}
	graph, e := s.groupGraph(ctx, store, id)
	g := graph.Group
	if e != nil {
		return g, e
	}

	if action == "cancel" && g.Status == "cancelled" {
		return g, nil
	}
	if g.Status == "success" || g.Status == "cancelled" {
		return g, errors.New("group is terminal")
	}
	now := time.Now().UTC()
	event := TaskEvent{ID: newID("event"), TaskID: id, Type: "group_" + action, Payload: eventPayload(in), CreatedAt: now}
	switch action {
	case "publish", "approve-plan":
		if in.PlanVersion == nil || *in.PlanVersion != g.PlanVersion {
			return g, errors.New("current plan_version required")
		}
		if len(graph.Tasks) == 0 {
			return g, errors.New("cannot publish empty group")
		}
		if e = ValidateDAG(graph.Edges); e != nil {
			return g, e
		}
		if !g.Published && action == "publish" {
			g.BlockReason = "publish_approval"
		} else {
			g.Published = true
			g.BlockReason = ""
		}
	case "pause":
		g.Status = "paused"
	case "resume":
		g.Status = "active"
		g.BlockReason = ""
	case "cancel":
		if strings.TrimSpace(in.Message) == "" {
			return g, errors.New("reason required")
		}
		g.Status = "cancelled"
	case "complete":
		if in.PlanVersion == nil || *in.PlanVersion != g.PlanVersion || strings.TrimSpace(in.Message) == "" {
			return g, errors.New("current plan_version and acceptance result required")
		}
		if e = groupAcceptable(graph); e != nil {
			return g, e
		}
		for _, m := range graph.Messages {
			if m.StageRunID == "" || g.Status != "coordinating" {
				return g, errors.New("group messages are awaiting automatic processing; wait for delivery to the parent conversation")
			}
		}
		g.Status = "success"
	default:
		return g, errors.New("unsupported group operation")
	}
	tx, e := store.db.BeginTx(ctx, nil)
	if e != nil {
		return g, e
	}
	defer tx.Rollback()
	if (action == "publish" || action == "approve-plan") && g.Published {
		if _, e = tx.ExecContext(ctx, `UPDATE tasks SET published=1,status=?,updated_at=? WHERE group_id=? AND published=0 AND status NOT IN ('success','cancelled')`, StatusPending, now.Format(time.RFC3339Nano), id); e != nil {
			return g, e
		}
	}
	g.UpdatedAt = now
	if e = saveGroup(ctx, tx, g); e != nil {
		return g, e
	}
	if e = insertTaskEvent(ctx, tx, event); e != nil {
		return g, e
	}
	if e = tx.Commit(); e != nil {
		return g, e
	}
	s.groupChanged(g)
	for _, d := range graph.Tasks {
		s.changed(ctx, store, d.Task.ID)
	}
	s.Schedule(root)
	return g, nil
}

// The group runner serializes notifications for the same parent conversation.
func (s *Service) refreshGroups(ctx context.Context, store *TaskStore) error {
	groups, e := store.listGroups(ctx)
	if e != nil {
		return e
	}
	runner, ok := s.Runner.(GroupRunner)
	if !ok {
		return nil
	}
	for _, g := range groups {
		if g.Status != "active" && g.Status != "paused" {
			continue
		}
		graph, e := s.groupGraph(ctx, store, g.ID)
		if e != nil {
			return e
		}
		if g.Status == "active" && len(graph.Messages) == 0 && groupAcceptable(graph) == nil {
			payload := eventPayload(map[string]any{"message": "All tasks completed. Perform overall acceptance, then complete this group or send instructions to specific tasks with -to-task.", "plan_version": g.PlanVersion})
			var n int
			if e = store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM task_events WHERE task_id=? AND type='acceptance_ready' AND json_extract(payload_json, '$.plan_version')=?`, g.ID, g.PlanVersion).Scan(&n); e != nil {
				return e
			}
			if n == 0 {
				if e = store.AddEvent(ctx, TaskEvent{ID: newID("event"), TaskID: g.ID, ReceiverTaskID: g.ID, Type: "acceptance_ready", Payload: payload, CreatedAt: time.Now().UTC()}); e != nil {
					return e
				}
				graph.Messages, e = store.Inbox(ctx, g.ID)
				if e != nil {
					return e
				}
			}
		}
		if len(graph.Messages) == 0 || runner.GroupSessionBusy(g.RootID, g.SessionKey) {
			continue
		}
		key := "group-session/" + g.RootID + "/" + g.SessionKey
		s.mu.Lock()
		if s.closed || s.running[key] {
			s.mu.Unlock()
			continue
		}
		if s.running == nil {
			s.running = map[string]bool{}
		}
		s.running[key] = true
		runCtx, runCancel := context.WithCancel(s.runCtx)
		if s.executionCancels == nil {
			s.executionCancels = map[string]context.CancelFunc{}
		}
		s.executionCancels[key] = runCancel
		s.workers.Add(1)
		s.mu.Unlock()
		turn := newID("group_turn")
		if g.Status == "active" {
			g.Status = "coordinating"
		}
		g.UpdatedAt = time.Now().UTC()
		tx, e := store.db.BeginTx(ctx, nil)
		if e == nil {
			e = saveGroup(ctx, tx, g)
			for _, m := range graph.Messages {
				if e == nil {
					_, e = tx.ExecContext(ctx, `UPDATE task_events SET stage_run_id=? WHERE id=?`, turn, m.ID)
				}
			}
			if e == nil {
				e = tx.Commit()
			} else {
				tx.Rollback()
			}
		}
		if e != nil {
			s.mu.Lock()
			delete(s.running, key)
			delete(s.executionCancels, key)
			runCancel()
			s.mu.Unlock()
			s.workers.Done()
			return e
		}
		s.groupChanged(g)
		go s.runGroupTurn(runCtx, store, runner, g, graph, turn, key)
	}
	return nil
}
func (s *Service) runGroupTurn(ctx context.Context, store *TaskStore, runner GroupRunner, g TaskGroup, graph GroupGraph, turn, key string) {
	defer s.workers.Done()
	defer func() {
		s.mu.Lock()
		if cancel := s.executionCancels[key]; cancel != nil {
			cancel()
		}
		delete(s.executionCancels, key)
		delete(s.running, key)
		s.mu.Unlock()
		s.Schedule(g.RootID)
	}()
	prompt := fmt.Sprintf("MindFS task group: root_id=%s group_id=%s plan_version=%d\n", g.RootID, g.ID, g.PlanVersion)
	acceptance := false
	for _, m := range graph.Messages {
		acceptance = acceptance || m.Type == "acceptance_ready"
		prompt += "\n"
		if m.TaskID != g.ID {
			prompt += "task_id=" + m.TaskID + "\n"
		}
		prompt += taskEventText(m) + "\n"
	}
	if acceptance {
		for _, d := range graph.Tasks {
			prompt += fmt.Sprintf("\nTask #%d id=%s status=%s", d.Task.TaskNumber, d.Task.ID, d.Task.Status)
		}
	}
	err := runner.RunGroupTurn(ctx, g, prompt)
	s.opMu.Lock()
	defer s.opMu.Unlock()
	current, e := store.getGroup(context.Background(), g.ID)
	if e != nil {
		return
	}
	now := time.Now().UTC()
	current.UpdatedAt = now
	if err != nil {
		if current.Status == "coordinating" || current.Status == "active" || current.Status == "success" || current.Status == "paused" {
			current.Status = "blocked"
			current.BlockReason = err.Error()
		}
	} else if current.Status == "coordinating" {
		current.Status = "active"
	}
	tx, e := store.db.BeginTx(context.Background(), nil)
	if e != nil {
		return
	}
	defer tx.Rollback()
	if err == nil {
		if _, e = tx.Exec(`UPDATE task_events SET handled_at=? WHERE receiver_task_id=? AND stage_run_id=? AND handled_at=''`, now.Format(time.RFC3339Nano), g.ID, turn); e != nil {
			return
		}
	}
	if e = saveGroup(context.Background(), tx, current); e == nil {
		e = tx.Commit()
	}
	if e == nil {
		s.groupChanged(current)
	}
}

// Appending work reopens completed groups in the same transaction as creation.
// Existing results and the original publication approval remain valid.
func appendToGroup(ctx context.Context, tx *sql.Tx, id string) error {
	if id == "" {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE task_groups SET status='active',block_reason='' WHERE id=? AND status='success'`, id); err != nil {
		return err
	}
	return bumpGroup(ctx, tx, id)
}

func bumpGroup(ctx context.Context, tx *sql.Tx, id string) error {
	if id == "" {
		return nil
	}
	_, e := tx.ExecContext(ctx, `UPDATE task_groups SET plan_version=plan_version+1,updated_at=? WHERE id=?`, time.Now().UTC().Format(time.RFC3339Nano), id)
	return e
}
func (s *Service) taskGroupChanged(ctx context.Context, store *TaskStore, id string) {
	if id != "" {
		if g, e := store.getGroup(ctx, id); e == nil {
			s.groupChanged(g)
		}
	}
}

// UpdateGroupContext changes only shared context; executing turns keep their prompt.
func (s *Service) UpdateGroupContext(ctx context.Context, root, id, value string, version int) (TaskGroup, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	store, err := s.taskStore(root)
	if err != nil {
		return TaskGroup{}, err
	}
	g, err := store.getGroup(ctx, id)
	if err != nil {
		return g, err
	}
	if g.Status == "success" || g.Status == "cancelled" {
		return g, errors.New("task group is terminal")
	}
	if g.PlanVersion != version {
		return g, errors.New("task group changed; reload before saving shared context")
	}
	if g.ProjectContext == value {
		return g, nil
	}
	g.ProjectContext = value
	g.PlanVersion++
	g.UpdatedAt = time.Now().UTC()
	_, err = store.db.ExecContext(ctx, "UPDATE task_groups SET project_context=?,plan_version=?,updated_at=? WHERE id=?", g.ProjectContext, g.PlanVersion, g.UpdatedAt.Format(time.RFC3339Nano), g.ID)
	if err != nil {
		return g, err
	}
	s.groupChanged(g)
	return g, nil
}
