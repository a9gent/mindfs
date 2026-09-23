package kanban

import (
	"context"
	"time"
)

// DeleteSessionGroups stops orchestration before deleting its records. Execution
// sessions are returned to the session service; worktrees and branches are untouched.
func (s *Service) DeleteSessionGroups(ctx context.Context, root string, sessions []string) ([]string, error) {
	s.opMu.Lock()
	store, err := s.taskStore(root)
	if err != nil {
		s.opMu.Unlock()
		return nil, err
	}
	groups, err := store.listGroups(ctx)
	if err != nil {
		s.opMu.Unlock()
		return nil, err
	}
	targets := map[string]bool{}
	for _, key := range sessions {
		targets[key] = true
	}
	var selected []TaskGroup
	var tasks []Task
	executionSessions := map[string]bool{}
	workerKeys := map[string]bool{}
	for _, g := range groups {
		if !targets[g.SessionKey] {
			continue
		}
		graph, e := s.groupGraph(ctx, store, g.ID)
		if e != nil {
			s.opMu.Unlock()
			return nil, e
		}
		selected = append(selected, g)
		workerKeys["group-session/"+root+"/"+g.SessionKey] = true
		for _, d := range graph.Tasks {
			tasks = append(tasks, d.Task)
			workerKeys[root+"/"+d.Task.ID] = true
			if d.Task.MainSessionKey != "" {
				executionSessions[d.Task.MainSessionKey] = true
			}
			for _, run := range d.StageRuns {
				if run.SessionKey != "" {
					executionSessions[run.SessionKey] = true
				}
			}
		}
	}
	if len(selected) == 0 {
		s.opMu.Unlock()
		return nil, nil
	}
	err = func() error {
		tx, e := store.db.BeginTx(ctx, nil)
		if e != nil {
			return e
		}
		defer tx.Rollback()
		for _, g := range selected {
			if _, e = tx.ExecContext(ctx, "UPDATE task_groups SET status='cancelled' WHERE id=?", g.ID); e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, "UPDATE tasks SET status='cancelled',published=0 WHERE group_id=?", g.ID); e != nil {
				return e
			}
		}
		return tx.Commit()
	}()
	s.opMu.Unlock()
	if err != nil {
		return nil, err
	}

	// Cancel the worker contexts as well as preventing new scheduling. Waiting
	// keeps late callbacks from writing to deleted records or recreating sessions.
	s.mu.Lock()
	for key := range workerKeys {
		if cancel := s.executionCancels[key]; cancel != nil {
			cancel()
		}
	}
	s.mu.Unlock()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		s.mu.Lock()
		active := false
		for key := range workerKeys {
			active = active || s.running[key]
		}
		s.mu.Unlock()
		if !active {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for _, task := range tasks {
		for _, query := range []string{
			"DELETE FROM task_dependencies WHERE task_id=? OR depends_on=?",
			"DELETE FROM task_events WHERE task_id=? OR receiver_task_id=?",
		} {
			if _, err = tx.ExecContext(ctx, query, task.ID, task.ID); err != nil {
				return nil, err
			}
		}
		for _, query := range []string{"DELETE FROM stage_runs WHERE task_id=?", "DELETE FROM tasks WHERE id=?"} {
			if _, err = tx.ExecContext(ctx, query, task.ID); err != nil {
				return nil, err
			}
		}
	}
	for _, g := range selected {
		if _, err = tx.ExecContext(ctx, "DELETE FROM task_events WHERE task_id=? OR receiver_task_id=?", g.ID, g.ID); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM task_groups WHERE id=?", g.ID); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	if notifier, ok := s.Runner.(interface{ TaskDeleted(string, string) }); ok {
		for _, task := range tasks {
			notifier.TaskDeleted(root, task.ID)
		}
	}
	keys := make([]string, 0, len(executionSessions))
	for key := range executionSessions {
		keys = append(keys, key)
	}
	return keys, nil
}
