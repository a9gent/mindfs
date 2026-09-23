package kanban

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Messages to an existing conversation do not acquire a task scheduler slot.
// RunAgentStage uses the same session send lock as ordinary user messages.
// The task worker guard serializes messages with the task's current execution.
func (s *Service) deliverTaskMessages(ctx context.Context, store *TaskStore, tasks []Task) error {
	if s.Runner == nil {
		return nil
	}
	for _, task := range tasks {
		if task.MainSessionKey == "" || task.Status == StatusCancelled {
			continue
		}
		s.mu.Lock()
		running := s.running[task.RootID+"/"+task.ID]
		s.mu.Unlock()
		if running || task.SchedulerAdmitted {
			continue
		}
		inbox, err := store.Inbox(ctx, task.ID)
		if err != nil {
			return err
		}
		fresh := false
		for _, event := range inbox {
			if event.StageRunID == "" {
				fresh = true
				break
			}
		}
		if !fresh {
			continue
		}
		// Also recover replies queued by earlier versions without task admission.
		if task.Status == StatusPending || task.Status == StatusQueued {
			if err := store.UpdateTaskStatus(ctx, task.ID, StatusWaitingUser, nil, false); err != nil {
				return err
			}
		}
		s.runTask(task.RootID, task.ID, true)
	}
	return nil
}

func (s *Service) executeTaskMessages(ctx context.Context, root, id string) error {
	store, task, tmpl, err := s.loadForMove(ctx, root, id)
	if err != nil {
		return err
	}
	if task.Status == StatusCancelled || task.MainSessionKey == "" {
		return nil
	}
	if task.CurrentStageIndex < 0 || task.CurrentStageIndex >= len(tmpl.Stages) {
		return fmt.Errorf("current stage out of range")
	}
	if tmpl.Stages[task.CurrentStageIndex].Snapshot.Role == RoleAgent {
		return s.executeManagedTurn(ctx, store, task, tmpl, true)
	}
	// A conversation remains reachable at a manual stage, but a message must not
	// approve that stage or move the task to another stage.
	s.opMu.Lock()
	inbox, err := store.Inbox(ctx, id)
	if err != nil {
		s.opMu.Unlock()
		return err
	}
	turn := newID("message")
	prompt := taskMessagesPrompt(inbox)
	for _, event := range inbox {
		if _, err = store.db.ExecContext(ctx, `UPDATE task_events SET stage_run_id=? WHERE id=? AND handled_at=''`, turn, event.ID); err != nil {
			s.opMu.Unlock()
			return err
		}
	}
	s.opMu.Unlock()
	if len(inbox) == 0 {
		return nil
	}
	stage := tmpl.Stages[task.CurrentStageIndex].Snapshot
	for i := task.CurrentStageIndex - 1; i >= 0; i-- {
		if tmpl.Stages[i].Snapshot.Role == RoleAgent {
			stage = tmpl.Stages[i].Snapshot
			break
		}
	}
	err = s.Runner.RunAgentStage(ctx, AgentStageExecution{RootID: root, RuntimeRootPath: task.WorktreePath, Task: task, Stage: stage, Run: StageRun{SessionKey: task.MainSessionKey}, Prompt: strings.TrimSpace(prompt)})
	if err != nil {
		return err
	}
	for _, event := range inbox {
		if _, err = store.db.ExecContext(ctx, `UPDATE task_events SET handled_at=? WHERE id=?`, time.Now().UTC().Format(time.RFC3339Nano), event.ID); err != nil {
			return err
		}
	}
	return nil
}

// Existing conversations already contain execution identity and project context.
func taskMessagesPrompt(inbox []TaskEvent) string {
	messages := make([]string, 0, len(inbox))
	for _, event := range inbox {
		messages = append(messages, taskEventText(event))
	}
	return strings.Join(messages, "\n\n")
}
