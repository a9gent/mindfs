package kanban

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"mindfs/server/internal/fs"

	_ "modernc.org/sqlite"
)

const taskDBMetaPath = "tasks/task-kanban.db"
const taskSelectColumns = "id, task_number, root_id, task_template_id, task_template_name, create_worktree, worktree_branch_mode, worktree_branch, current_stage_index, status, scheduler_admitted, main_session_key, worktree_root_id, worktree_path, aux_ask_user_waiting, aux_has_plan, aux_has_todos, aux_has_task, aux_session_error, labels_json, created_at, updated_at, completed_at, published, block_reason, group_id, agent_override, model_override"

type TaskStore struct {
	root fs.RootInfo
	db   *sql.DB
	now  func() time.Time
}

func NewTaskStore(root fs.RootInfo) (*TaskStore, error) {
	path, err := taskDBPath(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &TaskStore{root: root, db: db, now: time.Now}
	if err := store.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func taskDBPath(root fs.RootInfo) (string, error) {
	meta, err := root.EnsureMetaDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(meta, filepath.FromSlash(taskDBMetaPath)), nil
}

func (s *TaskStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *TaskStore) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	task_number INTEGER NOT NULL DEFAULT 0,
	root_id TEXT NOT NULL,
	task_template_id TEXT NOT NULL,
	task_template_name TEXT NOT NULL,
	create_worktree INTEGER NOT NULL DEFAULT 0,
	worktree_branch_mode TEXT NOT NULL DEFAULT '',
	worktree_branch TEXT NOT NULL DEFAULT '',
	current_stage_index INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'pending',
	scheduler_admitted INTEGER NOT NULL DEFAULT 0,
	main_session_key TEXT NOT NULL DEFAULT '',
	worktree_root_id TEXT NOT NULL DEFAULT '',
	worktree_path TEXT NOT NULL DEFAULT '',
	aux_ask_user_waiting INTEGER NOT NULL DEFAULT 0,
	aux_has_plan INTEGER NOT NULL DEFAULT 0,
	aux_has_todos INTEGER NOT NULL DEFAULT 0,
	aux_has_task INTEGER NOT NULL DEFAULT 0,
	aux_session_error TEXT NOT NULL DEFAULT '',
	labels_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	completed_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS stage_runs (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	stage_index INTEGER NOT NULL,
	stage_name TEXT NOT NULL,
	role TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	session_key TEXT NOT NULL DEFAULT '',
	input TEXT NOT NULL DEFAULT '',
	rendered_prompt TEXT NOT NULL DEFAULT '',
	started_at TEXT NOT NULL DEFAULT '',
	finished_at TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	stage_run_id TEXT NOT NULL DEFAULT '',
	type TEXT NOT NULL,
	payload_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_stage_runs_task_stage ON stage_runs(task_id, stage_index, created_at);
CREATE INDEX IF NOT EXISTS idx_task_events_task_created ON task_events(task_id, created_at);
`)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(`ALTER TABLE tasks ADD COLUMN create_worktree INTEGER NOT NULL DEFAULT 0`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		return err
	}
	if _, err := s.db.Exec(`ALTER TABLE tasks ADD COLUMN worktree_branch_mode TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		return err
	}
	if _, err := s.db.Exec(`ALTER TABLE tasks ADD COLUMN worktree_branch TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		return err
	}
	if _, err := s.db.Exec(`ALTER TABLE tasks ADD COLUMN task_number INTEGER NOT NULL DEFAULT 0`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		return err
	}
	if _, err := s.db.Exec(`ALTER TABLE tasks ADD COLUMN aux_ask_user_waiting INTEGER NOT NULL DEFAULT 0`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		return err
	}
	if _, err := s.db.Exec(`ALTER TABLE tasks ADD COLUMN aux_has_plan INTEGER NOT NULL DEFAULT 0`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		return err
	}
	if _, err := s.db.Exec(`ALTER TABLE tasks ADD COLUMN aux_has_todos INTEGER NOT NULL DEFAULT 0`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		return err
	}
	if _, err := s.db.Exec(`ALTER TABLE tasks ADD COLUMN aux_has_task INTEGER NOT NULL DEFAULT 0`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		return err
	}
	if _, err := s.db.Exec(`ALTER TABLE tasks ADD COLUMN aux_session_error TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		return err
	}
	if err := s.dropLegacyTaskColumns(); err != nil {
		return err
	}
	if err := s.migrateOrchestration(); err != nil {
		return err
	}
	if err := s.backfillTaskNumbers(); err != nil {
		return err
	}
	return err
}

func (s *TaskStore) dropLegacyTaskColumns() error {
	legacyColumns := []string{"template_snapshot_json", "is_parent_task", "parent_task_id", "plan_version", "project_context"}
	rows, err := s.db.Query(`PRAGMA table_info(tasks)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	existing := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, colType string
		var notNull, pk int
		var dfltValue any
		if err := rows.Scan(&cid, &name, &colType, &notNull, &dfltValue, &pk); err != nil {
			return err
		}
		existing[name] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	// Release the sole SQLite connection before executing schema changes.
	if err := rows.Close(); err != nil {
		return err
	}
	if _, err := s.db.Exec("DROP INDEX IF EXISTS idx_tasks_parent"); err != nil {
		return err
	}
	for _, column := range legacyColumns {
		if !existing[column] {
			continue
		}
		if _, err := s.db.Exec(`ALTER TABLE tasks DROP COLUMN ` + column); err != nil && !strings.Contains(strings.ToLower(err.Error()), "no such column") {
			return err
		}
	}
	return nil
}

func (s *TaskStore) backfillTaskNumbers() error {
	rows, err := s.db.Query(`SELECT id FROM tasks WHERE task_number = 0 ORDER BY created_at ASC`)
	if err != nil {
		return err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	var maxNumber int
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(task_number), 0) FROM tasks`).Scan(&maxNumber); err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, id := range ids {
		maxNumber++
		if _, err := tx.Exec(`UPDATE tasks SET task_number = ? WHERE id = ?`, maxNumber, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type ListTasksOptions struct {
	TemplateID       string
	Status           string
	TaskNumber       int
	Stage            int
	HasStage         bool
	After            string
	Before           string
	Limit            int
	CreatedDesc      bool
	CursorTaskNumber int
}

func (s *TaskStore) CreateTask(ctx context.Context, task Task, firstRun StageRun, event TaskEvent) (Task, error) {
	return s.CreateTaskWithDependencies(ctx, task, firstRun, event, nil)
}

func (s *TaskStore) CreateTaskWithDependencies(ctx context.Context, task Task, firstRun StageRun, event TaskEvent, deps []string) (Task, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback()
	if task.TaskNumber <= 0 {
		var maxNumber int
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(task_number), 0) FROM tasks`).Scan(&maxNumber); err != nil {
			return Task{}, err
		}
		task.TaskNumber = maxNumber + 1
	}
	if err := insertTask(ctx, tx, task); err != nil {
		return Task{}, err
	}
	if err := insertStageRun(ctx, tx, firstRun); err != nil {
		return Task{}, err
	}
	if err := insertTaskEvent(ctx, tx, event); err != nil {
		return Task{}, err
	}
	if err := replaceDependencies(ctx, tx, task.ID, deps); err != nil {
		return Task{}, err
	}
	if err := appendToGroup(ctx, tx, task.GroupID); err != nil {
		return Task{}, err
	}
	if err := tx.Commit(); err != nil {
		return Task{}, err
	}
	return task, nil
}

func (s *TaskStore) ListTasks(ctx context.Context, opts ListTasksOptions) ([]Task, error) {
	where := []string{"1=1"}
	args := []any{}
	if strings.TrimSpace(opts.TemplateID) != "" {
		where = append(where, "task_template_id = ?")
		args = append(args, strings.TrimSpace(opts.TemplateID))
	}
	if strings.TrimSpace(opts.Status) != "" {
		where = append(where, "status = ?")
		args = append(args, strings.TrimSpace(opts.Status))
	}
	if opts.TaskNumber > 0 {
		where = append(where, "task_number = ?")
		args = append(args, opts.TaskNumber)
	}
	if opts.HasStage {
		where = append(where, "current_stage_index = ?")
		args = append(args, opts.Stage)
	}
	if strings.TrimSpace(opts.After) != "" {
		where = append(where, "updated_at > ?")
		args = append(args, strings.TrimSpace(opts.After))
	}
	if strings.TrimSpace(opts.Before) != "" {
		where = append(where, "updated_at < ?")
		args = append(args, strings.TrimSpace(opts.Before))
	}
	limitClause := ""
	order := "updated_at DESC, created_at DESC"
	if opts.CreatedDesc {
		// Stored timestamps are UTC RFC3339Nano. Strip Z so whole seconds
		// sort before fractional seconds, including variable precision.
		order = "rtrim(created_at, 'Z') DESC, id DESC"
		if opts.CursorTaskNumber > 0 {
			var createdAt, id string
			err := s.db.QueryRowContext(ctx, "SELECT created_at, id FROM tasks WHERE task_number = ?", opts.CursorTaskNumber).Scan(&createdAt, &id)
			if errors.Is(err, sql.ErrNoRows) {
				return nil, errors.New("cursor task not found; restart pagination without -cursor")
			}
			if err != nil {
				return nil, err
			}
			where = append(where, "(rtrim(created_at, 'Z') < rtrim(?, 'Z') OR (created_at = ? AND id < ?))")
			args = append(args, createdAt, createdAt, id)
		}
	}
	if opts.Limit > 0 {
		limitClause = " LIMIT ?"
		args = append(args, opts.Limit)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+taskSelectColumns+` FROM tasks WHERE `+strings.Join(where, " AND ")+` ORDER BY `+order+limitClause, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Task{}
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, task)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	for i := range items {
		s.decorateCurrentStage(ctx, &items[i])
	}
	return items, nil
}

func (s *TaskStore) ListTaskDetails(ctx context.Context, opts ListTasksOptions) ([]TaskDetail, error) {
	tasks, err := s.ListTasks(ctx, opts)
	if err != nil {
		return nil, err
	}
	items := make([]TaskDetail, 0, len(tasks))
	for _, task := range tasks {
		runs, err := s.ListStageRuns(ctx, task.ID)
		if err != nil {
			return nil, err
		}
		events, err := s.ListEvents(ctx, task.ID)
		if err != nil {
			return nil, err
		}
		items = append(items, TaskDetail{Task: task, StageRuns: runs, Events: events})
	}
	return items, nil
}

func (s *TaskStore) ListQueuedTasks(ctx context.Context) ([]Task, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+taskSelectColumns+` FROM tasks WHERE status = ? ORDER BY created_at ASC`, StatusQueued)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Task{}
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, task)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	for i := range items {
		s.decorateCurrentStage(ctx, &items[i])
	}
	return items, nil
}

func (s *TaskStore) CountUnfinishedTasksByTemplate(ctx context.Context, templateID string) (int, error) {
	templateID = strings.TrimSpace(templateID)
	if templateID == "" {
		return 0, nil
	}
	var count int
	err := s.db.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM tasks WHERE task_template_id = ? AND status NOT IN (?, ?, ?)`,
		templateID,
		StatusSuccess,
		StatusFail,
		StatusCancelled,
	).Scan(&count)
	return count, err
}

func (s *TaskStore) GetTask(ctx context.Context, id string) (Task, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+taskSelectColumns+` FROM tasks WHERE id = ?`, strings.TrimSpace(id))
	task, err := scanTask(row)
	if err != nil {
		return Task{}, err
	}
	s.decorateCurrentStage(ctx, &task)
	return task, nil
}

func (s *TaskStore) GetDetail(ctx context.Context, id string) (TaskDetail, error) {
	task, err := s.GetTask(ctx, id)
	if err != nil {
		return TaskDetail{}, err
	}
	runs, err := s.ListStageRuns(ctx, id)
	if err != nil {
		return TaskDetail{}, err
	}
	events, err := s.ListEvents(ctx, id)
	if err != nil {
		return TaskDetail{}, err
	}
	task.DependsOn, err = s.Dependencies(ctx, task.ID)
	if err != nil {
		return TaskDetail{}, err
	}
	return TaskDetail{Task: task, StageRuns: runs, Events: events}, nil
}

func (s *TaskStore) ListStageRuns(ctx context.Context, taskID string) ([]StageRun, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, task_id, stage_index, stage_name, role, status, session_key, input, rendered_prompt, started_at, finished_at, created_at, updated_at, trigger, result FROM stage_runs WHERE task_id = ? ORDER BY created_at ASC`, strings.TrimSpace(taskID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []StageRun{}
	for rows.Next() {
		run, err := scanStageRun(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, run)
	}
	return items, rows.Err()
}

func (s *TaskStore) ListEvents(ctx context.Context, taskID string) ([]TaskEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, task_id, stage_run_id, type, payload_json, created_at, receiver_task_id, handled_at FROM task_events WHERE task_id = ? ORDER BY created_at ASC`, strings.TrimSpace(taskID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []TaskEvent{}
	for rows.Next() {
		event, err := scanTaskEvent(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, event)
	}
	return items, rows.Err()
}

func (s *TaskStore) LatestStageRun(ctx context.Context, taskID string, stageIndex int) (StageRun, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, task_id, stage_index, stage_name, role, status, session_key, input, rendered_prompt, started_at, finished_at, created_at, updated_at, trigger, result FROM stage_runs WHERE task_id = ? AND stage_index = ? ORDER BY created_at DESC LIMIT 1`, strings.TrimSpace(taskID), stageIndex)
	return scanStageRun(row)
}

func (s *TaskStore) UpdateTaskStatus(ctx context.Context, taskID, status string, admitted *bool, completed bool) error {
	now := s.now().UTC().Format(time.RFC3339Nano)
	set := []string{"status = ?", "updated_at = ?"}
	args := []any{strings.TrimSpace(status), now}
	if admitted != nil {
		set = append(set, "scheduler_admitted = ?")
		if *admitted {
			args = append(args, 1)
		} else {
			args = append(args, 0)
		}
	}
	if completed {
		set = append(set, "completed_at = ?")
		args = append(args, now)
		set = append(set, "aux_ask_user_waiting = ?")
		args = append(args, 0)
	}
	args = append(args, strings.TrimSpace(taskID))
	_, err := s.db.ExecContext(ctx, `UPDATE tasks SET `+strings.Join(set, ", ")+` WHERE id = ?`, args...)
	return err
}

func (s *TaskStore) UpdateTaskAuxFlags(ctx context.Context, taskID string, patch TaskAuxFlagsPatch) error {
	now := s.now().UTC().Format(time.RFC3339Nano)
	set := []string{"updated_at = ?"}
	args := []any{now}
	if patch.AskUserWaiting != nil {
		set = append(set, "aux_ask_user_waiting = ?")
		args = append(args, boolInt(*patch.AskUserWaiting))
	}
	if patch.HasPlan != nil {
		set = append(set, "aux_has_plan = ?")
		args = append(args, boolInt(*patch.HasPlan))
	}
	if patch.HasTodos != nil {
		set = append(set, "aux_has_todos = ?")
		args = append(args, boolInt(*patch.HasTodos))
	}
	if patch.HasTask != nil {
		set = append(set, "aux_has_task = ?")
		args = append(args, boolInt(*patch.HasTask))
	}
	if patch.SessionError != nil {
		set = append(set, "aux_session_error = ?")
		args = append(args, strings.TrimSpace(*patch.SessionError))
	}
	if len(set) == 1 {
		return nil
	}
	args = append(args, strings.TrimSpace(taskID))
	_, err := s.db.ExecContext(ctx, `UPDATE tasks SET `+strings.Join(set, ", ")+` WHERE id = ?`, args...)
	return err
}

func (s *TaskStore) UpdateTask(ctx context.Context, task Task) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := updateTaskCore(ctx, tx, task); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *TaskStore) MoveTask(ctx context.Context, task Task, run StageRun, event TaskEvent) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := updateTaskCore(ctx, tx, task); err != nil {
		return err
	}
	if strings.TrimSpace(run.ID) != "" {
		if err := insertStageRun(ctx, tx, run); err != nil {
			return err
		}
	}
	if err := insertTaskEvent(ctx, tx, event); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *TaskStore) UpdateStageRunStatus(ctx context.Context, runID, status string) error {
	now := s.now().UTC().Format(time.RFC3339Nano)
	finished := ""
	if status == StageStatusApproved || status == StageStatusRejected || status == StageStatusSuccess || status == StageStatusFail || status == StageStatusCancelled {
		finished = now
	}
	_, err := s.db.ExecContext(ctx, `UPDATE stage_runs SET status = ?, finished_at = CASE WHEN ? != '' THEN ? ELSE finished_at END, updated_at = ? WHERE id = ?`, strings.TrimSpace(status), finished, finished, now, strings.TrimSpace(runID))
	return err
}

func (s *TaskStore) UpdateStageRunExecution(ctx context.Context, run StageRun) error {
	now := s.now().UTC().Format(time.RFC3339Nano)
	set := []string{"status = ?", "session_key = ?", "input = ?", "rendered_prompt = ?", "updated_at = ?"}
	args := []any{strings.TrimSpace(run.Status), strings.TrimSpace(run.SessionKey), run.Input, run.RenderedPrompt, now}
	if strings.TrimSpace(run.StartedAt) != "" {
		set = append(set, "started_at = ?")
		args = append(args, strings.TrimSpace(run.StartedAt))
	}
	if strings.TrimSpace(run.FinishedAt) != "" {
		set = append(set, "finished_at = ?")
		args = append(args, strings.TrimSpace(run.FinishedAt))
	}
	args = append(args, strings.TrimSpace(run.ID))
	_, err := s.db.ExecContext(ctx, `UPDATE stage_runs SET `+strings.Join(set, ", ")+` WHERE id = ?`, args...)
	return err
}

func (s *TaskStore) UpdateStageRunInput(ctx context.Context, runID, input string) error {
	now := s.now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, `UPDATE stage_runs SET input = ?, updated_at = ? WHERE id = ?`, input, now, strings.TrimSpace(runID))
	return err
}

func (s *TaskStore) UpdateTaskAndStageRun(ctx context.Context, task Task, run StageRun, event TaskEvent) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := updateTaskCore(ctx, tx, task); err != nil {
		return err
	}
	now := s.now().UTC().Format(time.RFC3339Nano)
	_, err = tx.ExecContext(ctx, `UPDATE stage_runs SET status = ?, session_key = ?, input = ?, rendered_prompt = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
		run.Status, run.SessionKey, run.Input, run.RenderedPrompt, run.StartedAt, run.FinishedAt, now, run.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(event.ID) != "" {
		if err := insertTaskEvent(ctx, tx, event); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *TaskStore) AddEvent(ctx context.Context, event TaskEvent) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO task_events (id, task_id, stage_run_id, type, payload_json, created_at, receiver_task_id, handled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, event.ID, event.TaskID, event.StageRunID, event.Type, event.Payload, event.CreatedAt.UTC().Format(time.RFC3339Nano), event.ReceiverTaskID, event.HandledAt)
	return err
}

func (s *TaskStore) decorateCurrentStage(ctx context.Context, task *Task) {
	run, err := s.LatestStageRun(ctx, task.ID, task.CurrentStageIndex)
	if err != nil {
		return
	}
	task.CurrentStageName = run.StageName
	task.CurrentStageStatus = run.Status
}

func insertTask(ctx context.Context, tx *sql.Tx, task Task) error {
	labels, _ := json.Marshal(task.Labels)
	_, err := tx.ExecContext(ctx, `INSERT INTO tasks (id, task_number, root_id, task_template_id, task_template_name, create_worktree, worktree_branch_mode, worktree_branch, current_stage_index, status, scheduler_admitted, main_session_key, worktree_root_id, worktree_path, aux_ask_user_waiting, aux_has_plan, aux_has_todos, aux_has_task, aux_session_error, labels_json, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		task.ID, task.TaskNumber, task.RootID, task.TaskTemplateID, task.TaskTemplateName, boolInt(task.CreateWorktree), task.WorktreeBranchMode, task.WorktreeBranch, task.CurrentStageIndex, task.Status, boolInt(task.SchedulerAdmitted), task.MainSessionKey, task.WorktreeRootID, task.WorktreePath, boolInt(task.AuxFlags.AskUserWaiting), boolInt(task.AuxFlags.HasPlan), boolInt(task.AuxFlags.HasTodos), boolInt(task.AuxFlags.HasTask), strings.TrimSpace(task.AuxFlags.SessionError), string(labels), task.CreatedAt.UTC().Format(time.RFC3339Nano), task.UpdatedAt.UTC().Format(time.RFC3339Nano), task.CompletedAt)
	if err == nil {
		err = updateTaskOrchestration(ctx, tx, task)
	}
	return err
}

func updateTaskCore(ctx context.Context, tx *sql.Tx, task Task) error {
	labels, _ := json.Marshal(task.Labels)
	_, err := tx.ExecContext(ctx, `UPDATE tasks SET create_worktree = ?, worktree_branch_mode = ?, worktree_branch = ?, current_stage_index = ?, status = ?, scheduler_admitted = ?, main_session_key = ?, worktree_root_id = ?, worktree_path = ?, aux_ask_user_waiting = ?, aux_has_plan = ?, aux_has_todos = ?, aux_has_task = ?, aux_session_error = ?, labels_json = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
		boolInt(task.CreateWorktree), task.WorktreeBranchMode, task.WorktreeBranch, task.CurrentStageIndex, task.Status, boolInt(task.SchedulerAdmitted), task.MainSessionKey, task.WorktreeRootID, task.WorktreePath, boolInt(task.AuxFlags.AskUserWaiting), boolInt(task.AuxFlags.HasPlan), boolInt(task.AuxFlags.HasTodos), boolInt(task.AuxFlags.HasTask), strings.TrimSpace(task.AuxFlags.SessionError), string(labels), task.UpdatedAt.UTC().Format(time.RFC3339Nano), task.CompletedAt, task.ID)
	if err == nil {
		err = updateTaskOrchestration(ctx, tx, task)
	}
	return err
}

func insertStageRun(ctx context.Context, tx *sql.Tx, run StageRun) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO stage_runs (id, task_id, stage_index, stage_name, role, status, session_key, input, rendered_prompt, started_at, finished_at, created_at, updated_at, trigger, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		run.ID, run.TaskID, run.StageIndex, run.StageName, run.Role, run.Status, run.SessionKey, run.Input, run.RenderedPrompt, run.StartedAt, run.FinishedAt, run.CreatedAt.UTC().Format(time.RFC3339Nano), run.UpdatedAt.UTC().Format(time.RFC3339Nano), run.Trigger, run.Result)
	return err
}

func insertTaskEvent(ctx context.Context, tx *sql.Tx, event TaskEvent) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO task_events (id, task_id, stage_run_id, type, payload_json, created_at, receiver_task_id, handled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, event.ID, event.TaskID, event.StageRunID, event.Type, event.Payload, event.CreatedAt.UTC().Format(time.RFC3339Nano), event.ReceiverTaskID, event.HandledAt)
	return err
}

type scanner interface{ Scan(dest ...any) error }

func scanTask(row scanner) (Task, error) {
	var task Task
	var createWorktree, admitted, askUserWaiting, hasPlan, hasTodos, hasTask int
	var sessionError string
	var labels string
	var created, updated string
	if err := row.Scan(&task.ID, &task.TaskNumber, &task.RootID, &task.TaskTemplateID, &task.TaskTemplateName, &createWorktree, &task.WorktreeBranchMode, &task.WorktreeBranch, &task.CurrentStageIndex, &task.Status, &admitted, &task.MainSessionKey, &task.WorktreeRootID, &task.WorktreePath, &askUserWaiting, &hasPlan, &hasTodos, &hasTask, &sessionError, &labels, &created, &updated, &task.CompletedAt, &task.Published, &task.BlockReason, &task.GroupID, &task.Agent, &task.Model); err != nil {
		return Task{}, err
	}
	task.CreateWorktree = createWorktree != 0
	task.SchedulerAdmitted = admitted != 0
	task.AuxFlags = TaskAuxFlags{
		AskUserWaiting: askUserWaiting != 0,
		HasPlan:        hasPlan != 0,
		HasTodos:       hasTodos != 0,
		HasTask:        hasTask != 0,
		SessionError:   strings.TrimSpace(sessionError),
	}
	_ = json.Unmarshal([]byte(labels), &task.Labels)
	task.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	task.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updated)
	return task, nil
}

func scanStageRun(row scanner) (StageRun, error) {
	var run StageRun
	var created, updated string
	if err := row.Scan(&run.ID, &run.TaskID, &run.StageIndex, &run.StageName, &run.Role, &run.Status, &run.SessionKey, &run.Input, &run.RenderedPrompt, &run.StartedAt, &run.FinishedAt, &created, &updated, &run.Trigger, &run.Result); err != nil {
		return StageRun{}, err
	}
	run.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	run.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updated)
	return run, nil
}

func scanTaskEvent(row scanner) (TaskEvent, error) {
	var event TaskEvent
	var created string
	if err := row.Scan(&event.ID, &event.TaskID, &event.StageRunID, &event.Type, &event.Payload, &created, &event.ReceiverTaskID, &event.HandledAt); err != nil {
		return TaskEvent{}, err
	}
	event.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	return event, nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func isTerminalStatus(status string) bool {
	switch status {
	case StatusSuccess, StatusFail, StatusCancelled:
		return true
	default:
		return false
	}
}

func sortStageRunsDesc(items []StageRun) {
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})
}

var errNoRows = sql.ErrNoRows

func isNotFound(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
}
