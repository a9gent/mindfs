package kanban

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestTaskMessagesIgnoreSchedulingAndSerializeReplies(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	defer s.Close()
	target := groupTask(t, s, g, "target")
	busy := groupTask(t, s, g, "occupies shared workspace")
	busy.Task.Status, busy.Task.SchedulerAdmitted = StatusRunning, true
	if err := store.UpdateTask(ctx, busy.Task); err != nil {
		t.Fatal(err)
	}
	task := target.Task
	task.CurrentStageIndex, task.MainSessionKey, task.Status = 1, "existing-chat", StatusWaitingUser
	if err := store.UpdateTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	run := StageRun{ID: newID("run"), TaskID: task.ID, StageIndex: 1, StageName: "Coordinate", Role: RoleAgent, Status: StageStatusSuccess, SessionKey: task.MainSessionKey, CreatedAt: now, UpdatedAt: now}
	if err := store.MoveTask(ctx, task, run, TaskEvent{ID: newID("event"), TaskID: task.ID, Type: "test", Payload: "{}", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	// Neither an unpublished/paused group nor occupied task slots block messages.
	if _, err := store.db.ExecContext(ctx, `UPDATE task_groups SET status='paused',project_context='shared context must not repeat' WHERE id=?`, g.ID); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	received := make(chan string, 2)
	s.Runner = &orchestrationRunner{run: func(exec AgentStageExecution) error {
		if exec.Run.SessionKey != "existing-chat" || exec.Task.SchedulerAdmitted {
			t.Error("reply acquired task slot or changed session")
		}
		n := calls.Add(1)
		if n == 1 {
			if exec.Prompt != "first reply" {
				t.Error("first reply missing")
			}
			if _, err := s.ManagedAction(ctx, g.RootID, task.ID, "to-task", ManagedInput{Message: "second reply"}); err != nil {
				return err
			}
			current, _ := store.GetTask(ctx, task.ID)
			if current.Status != StatusRunning {
				t.Error("new message disrupted active turn")
			}
		} else if n == 2 {
			if exec.Prompt != "second reply" {
				t.Error("reply duplicated or lost")
			}
		} else {
			t.Error("unexpected extra turn")
		}
		_, err := s.ManagedAction(ctx, g.RootID, task.ID, "from-task", ManagedInput{Message: "done", Completed: true})
		received <- exec.Prompt
		return err
	}}
	if _, err := s.ManagedAction(ctx, g.RootID, task.ID, "to-task", ManagedInput{Message: "first reply"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-received:
		case <-time.After(3 * time.Second):
			t.Fatal("reply blocked by task scheduling")
		}
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		current, err := store.GetTask(ctx, task.ID)
		inbox, e := store.Inbox(ctx, task.ID)
		if err == nil && e == nil && current.Status == StatusSuccess && len(inbox) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("delivery not finalized: %+v inbox=%+v err=%v", current, inbox, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	current, err := store.GetTask(ctx, busy.Task.ID)
	if err != nil || !current.SchedulerAdmitted {
		t.Fatal("other task slot changed")
	}
}

func TestPausedGroupStillReceivesReports(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	defer s.Close()
	task := groupTask(t, s, g, "question")
	if _, err := store.db.ExecContext(ctx, `UPDATE task_groups SET status='paused' WHERE id=?`, g.ID); err != nil {
		t.Fatal(err)
	}
	received := make(chan string, 1)
	s.Runner = &groupTestRunner{turn: func(_ TaskGroup, prompt string) error { received <- prompt; return nil }}
	if _, err := s.ManagedAction(ctx, g.RootID, task.Task.ID, "from-task", ManagedInput{Message: "question while paused"}); err != nil {
		t.Fatal(err)
	}
	select {
	case prompt := <-received:
		if !strings.Contains(prompt, "question while paused") {
			t.Fatal("report missing")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("pause blocked report")
	}
	current, err := store.getGroup(ctx, g.ID)
	if err != nil || current.Status != "paused" {
		t.Fatalf("communication resumed task scheduling: %+v %v", current, err)
	}
}

func TestTaskMessageDoesNotAdvanceManualStage(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	defer s.Close()
	target := groupTask(t, s, g, "manual input")
	tmpl, err := s.TaskExecutionTemplate(target.Task)
	if err != nil {
		t.Fatal(err)
	}
	tmpl.Stages = append(tmpl.Stages, TaskTemplateStage{Position: 2, Snapshot: StageTemplate{Name: "Review", Role: RoleUser}})
	if _, err = s.Templates.SaveTaskTemplate(tmpl); err != nil {
		t.Fatal(err)
	}
	task := target.Task
	task.CurrentStageIndex, task.MainSessionKey, task.Status = 2, "existing-chat", StatusWaitingUser
	if err = store.UpdateTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ManagedAction(ctx, g.RootID, task.ID, "to-task", ManagedInput{Message: "clarify requirements"}); err != nil {
		t.Fatal(err)
	}
	s.Runner = &orchestrationRunner{run: func(exec AgentStageExecution) error {
		if exec.Run.SessionKey != "existing-chat" || exec.Prompt != "clarify requirements" {
			t.Error("manual-stage conversation did not receive message")
		}
		if _, err := s.ManagedAction(ctx, g.RootID, task.ID, "from-task", ManagedInput{Message: "answer"}); err != nil {
			return err
		}
		return nil
	}}
	if err = s.executeTaskMessages(ctx, g.RootID, task.ID); err != nil {
		t.Fatal(err)
	}
	current, err := store.GetTask(ctx, task.ID)
	if err != nil || current.CurrentStageIndex != 2 || current.Status != StatusWaitingUser || current.SchedulerAdmitted {
		t.Fatalf("message advanced manual stage: %+v %v", current, err)
	}
}
