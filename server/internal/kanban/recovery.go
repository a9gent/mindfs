package kanban

import (
	"context"
	"log"
	"time"
)

// Start restores queued work, including roots added after server startup.
// Interrupted executions are surfaced for explicit recovery, never replayed blindly.
func (s *Service) Start(ctx context.Context) {
	go func() {
		tick := time.NewTicker(5 * time.Second)
		defer tick.Stop()
		for {
			for _, root := range s.Roots.ListRoots() {
				s.Schedule(root.ID)
			}
			select {
			case <-ctx.Done():
				s.Close()
				return
			case <-tick.C:
			}
		}
	}()
}
func (s *TaskStore) recoverManaged() error {
	ctx := context.Background()
	if _, err := s.db.ExecContext(ctx, `UPDATE task_groups SET status='blocked',block_reason='execution_interrupted: inspect parent session then resume' WHERE status='coordinating'`); err != nil {
		return err
	}
	tasks, err := s.ListTasks(ctx, ListTasksOptions{})
	if err != nil {
		return err
	}
	for _, t := range tasks {
		if t.GroupID == "" || !t.SchedulerAdmitted {
			continue
		}
		t.SchedulerAdmitted = false
		t.Status = StatusFail
		t.BlockReason = "execution_interrupted: inspect the existing session, then send instructions with -to-task"
		t.UpdatedAt = time.Now().UTC()
		tx, e := s.db.BeginTx(ctx, nil)
		if e != nil {
			return e
		}
		if e = updateTaskCore(ctx, tx, t); e == nil {
			_, e = tx.ExecContext(ctx, `UPDATE stage_runs SET status='fail' WHERE task_id=? AND status='running'`, t.ID)
		}
		if e == nil {
			e = insertTaskEvent(ctx, tx, TaskEvent{ID: newID("event"), TaskID: t.ID, ReceiverTaskID: t.GroupID, Type: "execution_interrupted", Payload: eventPayload(map[string]string{"message": t.BlockReason}), CreatedAt: t.UpdatedAt})
		}
		if e != nil {
			tx.Rollback()
			return e
		}
		if e = tx.Commit(); e != nil {
			return e
		}
		log.Printf("[kanban] interrupted execution requires recovery task=%s", t.ID)
	}
	return nil
}
