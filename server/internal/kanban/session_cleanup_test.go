package kanban

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type cleanupRunner struct {
	groupTestRunner
	started chan struct{}
	exited  chan struct{}
}

func (r *cleanupRunner) RunAgentStage(ctx context.Context, exec AgentStageExecution) error {
	close(r.started)
	<-ctx.Done()
	close(r.exited)
	return ctx.Err()
}

func TestDeleteSessionGroupsStopsExecutionAndPreservesWorktree(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, store, g := groupFixture(t)
	task := groupTask(t, s, g, "worker")
	dependent := groupTask(t, s, g, "dependent", task.Task.ID)
	s.Runner = &groupTestRunner{}
	other, err := s.CreateGroup(ctx, TaskGroup{RootID: g.RootID, SessionKey: "unrelated", Title: "keep"})
	if err != nil {
		t.Fatal(err)
	}
	s.Runner = nil
	keep := groupTask(t, s, other, "keep")
	worktree := t.TempDir()
	marker := filepath.Join(worktree, "code.txt")
	if err := os.WriteFile(marker, []byte("keep code"), 0600); err != nil {
		t.Fatal(err)
	}
	task.Task.WorktreePath = worktree
	task.Task.Published = true
	task.Task.Status = StatusRunning
	task.Task.SchedulerAdmitted = true
	if err := store.UpdateTask(ctx, task.Task); err != nil {
		t.Fatal(err)
	}
	runner := &cleanupRunner{started: make(chan struct{}), exited: make(chan struct{})}
	s.Runner = runner
	s.RunTask(g.RootID, task.Task.ID)
	select {
	case <-runner.started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	keys, err := s.DeleteSessionGroups(ctx, g.RootID, []string{g.SessionKey})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-runner.exited:
	default:
		t.Fatal("deleted before worker exited")
	}
	if len(keys) != 1 {
		t.Fatalf("missing execution session: %v", keys)
	}
	for _, id := range []string{task.Task.ID, dependent.Task.ID} {
		if _, err := store.GetTask(ctx, id); err == nil {
			t.Fatal("task retained", id)
		}
	}
	if _, err := store.getGroup(ctx, g.ID); err == nil {
		t.Fatal("group retained")
	}
	if _, err := store.GetTask(ctx, keep.Task.ID); err != nil {
		t.Fatal("unrelated task deleted", err)
	}
	for _, table := range []string{"task_dependencies", "stage_runs", "task_events"} {
		var n int
		query := "SELECT count(*) FROM " + table + " WHERE task_id=?"
		if err := store.db.QueryRowContext(ctx, query, task.Task.ID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s retained: %d %v", table, n, err)
		}
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "keep code" {
		t.Fatal("worktree changed", err)
	}
	if _, err = s.DeleteSessionGroups(ctx, g.RootID, []string{g.SessionKey}); err != nil {
		t.Fatal("cleanup not idempotent", err)
	}
}

func TestDropLegacyTaskColumnsPreservesDataAndCanRepeat(t *testing.T) {
	_, store, task := orchestrationFixture(t)
	if _, err := store.db.Exec("ALTER TABLE tasks ADD COLUMN template_snapshot_json TEXT NOT NULL DEFAULT '{}'"); err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"is_parent_task", "parent_task_id", "plan_version", "project_context"} {
		if _, err := store.db.Exec("ALTER TABLE tasks ADD COLUMN " + column + " TEXT NOT NULL DEFAULT ''"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.db.Exec("CREATE INDEX idx_tasks_parent ON tasks(parent_task_id)"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	before, err := store.getGroup(ctx, task.Task.GroupID)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := store.migrate(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.GetTask(context.Background(), task.Task.ID); err != nil {
		t.Fatal("task lost", err)
	}
	for _, column := range []string{"template_snapshot_json", "is_parent_task", "parent_task_id", "plan_version", "project_context"} {
		if _, err := store.db.Exec("SELECT " + column + " FROM tasks"); err == nil {
			t.Fatal("legacy column not removed", column)
		}
	}
	after, err := store.getGroup(ctx, before.ID)
	if err != nil || after != before {
		t.Fatalf("group changed during migration: %+v %v", after, err)
	}
}

func (r *cleanupRunner) RunGroupTurn(ctx context.Context, _ TaskGroup, _ string) error {
	close(r.started)
	<-ctx.Done()
	close(r.exited)
	return ctx.Err()
}

func TestDeleteSessionGroupsStopsParentCoordination(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, store, g := groupFixture(t)
	d := groupTask(t, s, g, "worker")
	if _, err := s.ManagedAction(ctx, g.RootID, d.Task.ID, "from-task", ManagedInput{Message: "question"}); err != nil {
		t.Fatal(err)
	}
	runner := &cleanupRunner{started: make(chan struct{}), exited: make(chan struct{})}
	s.Runner = runner
	s.Schedule(g.RootID)
	select {
	case <-runner.started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err := s.DeleteSessionGroups(ctx, g.RootID, []string{g.SessionKey}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-runner.exited:
	default:
		t.Fatal("parent coordination still running")
	}
	if _, err := store.getGroup(ctx, g.ID); err == nil {
		t.Fatal("parent callback recreated group")
	}
}
