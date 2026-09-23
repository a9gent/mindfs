package kanban

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

func (s *TaskStore) migrateOrchestration() error {
	columns := map[string][]string{
		"tasks":       {"agent_override TEXT NOT NULL DEFAULT ''", "model_override TEXT", "group_id TEXT NOT NULL DEFAULT ''", "published INTEGER NOT NULL DEFAULT 0", "block_reason TEXT NOT NULL DEFAULT ''"},
		"stage_runs":  {"trigger TEXT NOT NULL DEFAULT ''", "result TEXT NOT NULL DEFAULT ''"},
		"task_events": {"receiver_task_id TEXT NOT NULL DEFAULT ''", "handled_at TEXT NOT NULL DEFAULT ''"},
	}
	for table, defs := range columns {
		for _, def := range defs {
			if _, err := s.db.Exec("ALTER TABLE " + table + " ADD COLUMN " + def); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
				return err
			}
		}
	}
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS task_groups (
 id TEXT PRIMARY KEY,root_id TEXT NOT NULL,session_key TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',project_context TEXT NOT NULL DEFAULT '',published INTEGER NOT NULL DEFAULT 0,plan_version INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',block_reason TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_groups_session ON task_groups(session_key);
 CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id);
 CREATE TABLE IF NOT EXISTS task_dependencies (
 task_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY(task_id, depends_on), CHECK(task_id <> depends_on));
 CREATE INDEX IF NOT EXISTS idx_dependencies_upstream ON task_dependencies(depends_on);
 CREATE INDEX IF NOT EXISTS idx_events_inbox ON task_events(receiver_task_id, handled_at);`)
	return err
}

func updateTaskOrchestration(ctx context.Context, tx *sql.Tx, t Task) error {
	_, err := tx.ExecContext(ctx, `UPDATE tasks SET agent_override=?, model_override=?, group_id=?, published=?, block_reason=? WHERE id=?`, t.Agent, t.Model, t.GroupID, t.Published, t.BlockReason, t.ID)
	return err
}

func (s *TaskStore) Dependencies(ctx context.Context, id string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT depends_on FROM task_dependencies WHERE task_id=? ORDER BY depends_on`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func replaceDependencies(ctx context.Context, tx *sql.Tx, id string, deps []string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM task_dependencies WHERE task_id=?`, id); err != nil {
		return err
	}
	for _, dep := range deps {
		if _, err := tx.ExecContext(ctx, `INSERT INTO task_dependencies(task_id,depends_on) VALUES(?,?)`, id, dep); err != nil {
			return err
		}
	}
	return nil
}

// ValidateDAG reports the actual cycle, rather than a generic save failure.
func ValidateDAG(edges map[string][]string) error {
	state := map[string]int{}
	path := []string{}
	var visit func(string) error
	visit = func(id string) error {
		if state[id] == 2 {
			return nil
		}
		if state[id] == 1 {
			start := 0
			for i, v := range path {
				if v == id {
					start = i
					break
				}
			}
			return fmt.Errorf("dependency cycle: %s", strings.Join(append(append([]string{}, path[start:]...), id), " -> "))
		}
		state[id] = 1
		path = append(path, id)
		seen := map[string]bool{}
		for _, dep := range edges[id] {
			if seen[dep] {
				return fmt.Errorf("duplicate dependency: %s", dep)
			}
			seen[dep] = true
			if _, ok := edges[dep]; !ok {
				return fmt.Errorf("dependency %s is outside this task group", dep)
			}
			if err := visit(dep); err != nil {
				return err
			}
		}
		path = path[:len(path)-1]
		state[id] = 2
		return nil
	}
	for id := range edges {
		if err := visit(id); err != nil {
			return err
		}
	}
	return nil
}

// History includes delivered messages and completion reports, which have no inbox receiver.
func (s *TaskStore) groupMessageHistory(ctx context.Context, group TaskGroup) ([]GroupMessage, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,task_id,stage_run_id,type,payload_json,created_at,receiver_task_id,handled_at FROM task_events
 WHERE (type IN ('to-task','from-task') OR (receiver_task_id=? AND task_id<>?))
 AND (task_id=? OR task_id IN (SELECT id FROM tasks WHERE group_id=?) OR receiver_task_id IN (SELECT id FROM tasks WHERE group_id=?))
 ORDER BY created_at,id`, group.ID, group.ID, group.ID, group.ID, group.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GroupMessage{}
	for rows.Next() {
		event, err := scanTaskEvent(rows)
		if err != nil {
			return nil, err
		}
		from, to := event.TaskID, group.SessionKey
		if event.Type == "to-task" {
			from, to = group.SessionKey, event.ReceiverTaskID
		}
		out = append(out, GroupMessage{From: from, To: to, Message: taskEventText(event), Timestamp: event.CreatedAt})
	}
	return out, rows.Err()
}

func (s *TaskStore) Inbox(ctx context.Context, id string) ([]TaskEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, task_id, stage_run_id, type, payload_json, created_at, receiver_task_id, handled_at FROM task_events WHERE receiver_task_id=? AND handled_at='' ORDER BY created_at,id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TaskEvent{}
	for rows.Next() {
		v, e := scanTaskEvent(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Service) Messages(ctx context.Context, root, id string) ([]TaskEvent, error) {
	store, e := s.taskStore(root)
	if e != nil {
		return nil, e
	}
	rows, e := store.db.QueryContext(ctx, `SELECT id,task_id,stage_run_id,type,payload_json,created_at,receiver_task_id,handled_at FROM task_events WHERE (task_id=? OR receiver_task_id=?) AND receiver_task_id<>'' ORDER BY created_at,id`, id, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []TaskEvent{}
	for rows.Next() {
		v, e := scanTaskEvent(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
