package kanban

import (
	"context"
	"errors"
	"mindfs/server/internal/fs"
	"strings"
	"testing"
	"time"
)

func orchestrationFixture(t *testing.T) (*Service, *TaskStore, TaskDetail) {
	t.Helper()
	ctx := context.Background()
	root := fs.RootInfo{ID: "root", RootPath: t.TempDir()}
	templates := NewTemplateStoreAt(t.TempDir())
	tmpl, e := templates.SaveTaskTemplate(TaskTemplate{Name: "Parent", MaxConcurrency: 2, Stages: []TaskTemplateStage{{Position: 0, Snapshot: StageTemplate{Name: "Input", Role: RoleUser}}, {Position: 1, Snapshot: StageTemplate{Name: "Coordinate", Role: RoleAgent, Agent: "codex", PromptTemplate: "{previous_input}"}}}})
	if e != nil {
		t.Fatal(e)
	}
	svc := NewService(templates, testRoots{root})
	parent, e := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "Build feature"})
	if e != nil {
		t.Fatal(e)
	}
	store, e := svc.taskStore(root.ID)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(svc.Close)
	svc.Runner = &groupTestRunner{}
	group, err := svc.CreateGroup(ctx, TaskGroup{RootID: root.ID, SessionKey: "parent-chat", Title: "Feature"})
	if err != nil {
		t.Fatal(err)
	}
	svc.Runner = nil
	parent.Task.GroupID = group.ID
	return svc, store, parent
}
func child(t *testing.T, s *Service, p TaskDetail, key string, deps ...string) TaskDetail {
	t.Helper()
	d, e := s.CreateTask(context.Background(), CreateTaskInput{RootID: p.Task.RootID, GroupID: p.Task.GroupID, TaskTemplateID: p.Task.TaskTemplateID, Input: key, DependsOn: deps})
	if e != nil {
		t.Fatal(e)
	}
	return d
}
func approve(t *testing.T, s *Service, p TaskDetail) {
	t.Helper()
	g, e := s.GroupGraph(context.Background(), p.Task.RootID, p.Task.GroupID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.GroupAction(context.Background(), p.Task.RootID, p.Task.GroupID, "approve-plan", ManagedInput{PlanVersion: &g.Group.PlanVersion}); e != nil {
		t.Fatal(e)
	}
}
func TestOrchestrationPublicationAndDAG(t *testing.T) {
	ctx := context.Background()
	s, store, p := orchestrationFixture(t)
	a := child(t, s, p, "a")
	b := child(t, s, p, "b", a.Task.ID)
	if _, e := s.Next(ctx, MoveInput{RootID: p.Task.RootID, TaskID: a.Task.ID}); e == nil {
		t.Fatal("unpublished child started")
	}
	deps := []string{b.Task.ID}
	if _, e := s.PatchTask(ctx, p.Task.RootID, a.Task.ID, TaskPatch{DependsOn: &deps}); e == nil || !strings.Contains(e.Error(), "cycle") {
		t.Fatalf("cycle not rejected: %v", e)
	}
	version := 0
	if _, e := s.GroupAction(ctx, p.Task.RootID, p.Task.GroupID, "approve-plan", ManagedInput{PlanVersion: &version}); e == nil {
		t.Fatal("stale approval accepted")
	}
	approve(t, s, p)

	a.Task, _ = store.GetTask(ctx, a.Task.ID)
	b.Task, _ = store.GetTask(ctx, b.Task.ID)
	if !s.managedReady(ctx, store, a.Task) || s.managedReady(ctx, store, b.Task) {
		t.Fatal("incorrect dependency readiness")
	}
	// Editing a ready child freezes it until the next publish.
	input := "updated"
	d, e := s.PatchTask(ctx, p.Task.RootID, a.Task.ID, TaskPatch{Input: &input})
	if e != nil || d.Task.Published {
		t.Fatalf("edit didn't unpublish: %v", e)
	}
}
func TestOrchestrationOverridesAndIndependentCreation(t *testing.T) {
	ctx := context.Background()
	s, _, p := orchestrationFixture(t)
	if _, err := s.CreateTask(ctx, CreateTaskInput{RootID: p.Task.RootID, Input: "no template"}); err == nil || !strings.Contains(err.Error(), "task_template_id required") {
		t.Fatalf("standalone task must require template: %v", err)
	}

	a := child(t, s, p, "stable")
	again := child(t, s, p, "stable")
	if again.Task.ID == a.Task.ID {
		t.Fatal("separate creation reused task")
	}

	tmpl, _ := s.Templates.GetTaskTemplate(p.Task.TaskTemplateID)
	tmpl.Stages[1].Snapshot.PromptTemplate = "NEW WORKFLOW"
	if _, e := s.SaveTaskTemplate(ctx, tmpl); e == nil {
		t.Fatal("editing template with unfinished tasks must fail")
	}
	if e := s.DeleteTaskTemplate(ctx, tmpl.ID); e == nil {
		t.Fatal("deleting template with unfinished tasks must fail")
	}
	b := child(t, s, p, "new")
	agent := "claude"
	model := "test-model"
	branch := "feature/custom"
	mode := "new"
	yes := true
	d, e := s.PatchTask(ctx, p.Task.RootID, b.Task.ID, TaskPatch{Agent: &agent, Model: &model, CreateWorktree: &yes, WorktreeBranch: &branch, WorktreeBranchMode: &mode})
	if e != nil {
		t.Fatal(e)
	}
	if d.Task.Agent != agent || d.Task.Model == nil || *d.Task.Model != model || d.Task.WorktreeBranch != branch {
		t.Fatal("instance config lost")
	}
	resolved, err := s.TaskExecutionTemplate(d.Task)
	if err != nil || resolved.Stages[1].Snapshot.Agent != agent || resolved.Stages[1].Snapshot.Model != model {
		t.Fatalf("overrides not applied: %v", err)
	}
	original, _ := s.Templates.GetTaskTemplate(d.Task.TaskTemplateID)
	if original.Stages[1].Snapshot.Agent != "codex" {
		t.Fatal("task override changed template")
	}
	persisted, err := s.GetTask(ctx, p.Task.RootID, d.Task.ID)
	if err != nil || persisted.Task.Agent != agent || persisted.Task.Model == nil || *persisted.Task.Model != model {
		t.Fatal("overrides not persisted", err)
	}

	empty := ""
	cleared, err := s.PatchTask(ctx, p.Task.RootID, d.Task.ID, TaskPatch{Model: &empty})
	if err != nil {
		t.Fatal(err)
	}
	effective, err := s.TaskExecutionTemplate(cleared.Task)
	if err != nil || effective.Stages[1].Snapshot.Model != "" {
		t.Fatal("explicit empty model was not respected", err)
	}
	created, err := s.CreateTask(ctx, CreateTaskInput{RootID: p.Task.RootID, TaskTemplateID: p.Task.TaskTemplateID, Input: "override at creation", Agent: agent, Model: model})
	if err != nil {
		t.Fatal(err)
	}
	effective, err = s.TaskExecutionTemplate(created.Task)
	if err != nil || effective.Stages[1].Snapshot.Agent != agent || effective.Stages[1].Snapshot.Model != model {
		t.Fatal("creation overrides not applied", err)
	}

}

type orchestrationRunner struct {
	fakeRunner
	run func(AgentStageExecution) error
}

func (r *orchestrationRunner) EnsureAgentSession(ctx context.Context, exec AgentStageExecution) (string, error) {
	if exec.Task.MainSessionKey != "" {
		return exec.Task.MainSessionKey, nil
	}
	return r.fakeRunner.EnsureAgentSession(ctx, exec)
}

func (r *orchestrationRunner) RunAgentStage(ctx context.Context, e AgentStageExecution) error {
	return r.run(e)
}
func TestNewInstructionsReopenOnlyTargetAndPreserveResults(t *testing.T) {
	ctx := context.Background()
	s, store, p := orchestrationFixture(t)
	a := child(t, s, p, "a")
	b := child(t, s, p, "b", a.Task.ID)
	approve(t, s, p)
	runner := &orchestrationRunner{}
	runner.run = func(exec AgentStageExecution) error {
		if !strings.Contains(exec.Prompt, "Read mindfs -orchestration for CLI usage. Report with -from-task; set completed: true when the current stage is complete.") {
			t.Error("initial task prompt missing reporting instructions")
		}
		for _, redundant := range []string{"## MindFS execution", "MindFS task:", "root_id:", "task_id:"} {
			if strings.Contains(exec.Prompt, redundant) {
				t.Errorf("task prompt duplicates session identity: %s", redundant)
			}
		}
		if _, e := s.ManagedAction(ctx, p.Task.RootID, a.Task.ID, "from-task", ManagedInput{Completed: true, Message: "commit abc; tests pass"}); e != nil {
			return e
		}
		current, _ := store.GetTask(ctx, a.Task.ID)

		downstream, _ := store.GetTask(ctx, b.Task.ID)
		if current.Status == StatusSuccess || !current.SchedulerAdmitted || s.managedReady(ctx, store, downstream) {
			t.Error("completion released execution before agent exit")
		}
		return nil
	}
	s.Runner = runner
	a.Task, _ = store.GetTask(ctx, a.Task.ID)
	a.Task.Status = StatusRunning
	a.Task.SchedulerAdmitted = true
	if e := store.UpdateTask(ctx, a.Task); e != nil {
		t.Fatal(e)
	}
	if e := s.executeTask(ctx, p.Task.RootID, a.Task.ID); e != nil {
		t.Fatal(e)
	}
	done, _ := store.GetDetail(ctx, a.Task.ID)
	if done.Task.Status != StatusSuccess || done.Task.SchedulerAdmitted {
		t.Fatal("completion not committed")
	}
	// Inspect message-driven reopening without asynchronous scheduling.
	s.Runner = nil
	b.Task, _ = store.GetTask(ctx, b.Task.ID)
	b.Task.Status = StatusSuccess
	b.Task.CompletedAt = time.Now().Format(time.RFC3339Nano)
	_ = store.UpdateTask(ctx, b.Task)
	if _, e := s.ManagedAction(ctx, p.Task.RootID, a.Task.ID, "to-task", ManagedInput{Message: "fix edge case"}); e != nil {
		t.Fatal(e)
	}
	downstream, _ := store.GetTask(ctx, b.Task.ID)
	if downstream.Status != StatusSuccess || downstream.BlockReason != "" {
		t.Fatal("unaddressed downstream task changed")
	}
	revised, _ := store.GetDetail(ctx, a.Task.ID)
	if revised.Task.Status != StatusWaitingUser || revised.Task.CompletedAt != "" || len(revised.StageRuns) != len(done.StageRuns) || revised.StageRuns[1].Result == "" {
		t.Fatal("new instructions lost history or kept target complete")
	}
	runner.run = func(exec AgentStageExecution) error {
		if exec.Run.ID == done.StageRuns[1].ID || exec.Task.MainSessionKey != done.Task.MainSessionKey || !strings.Contains(exec.Prompt, "fix edge case") {
			t.Error("follow-up did not reuse session with a new execution and message")
		}
		for _, redundant := range []string{`"message"`, "parent_task_id:", "parent_session_key:", "plan_version:", "Read mindfs -orchestration", "## 共享上下文", "## MindFS execution", "root_id:", "task_id:", "## 前置任务"} {
			if strings.Contains(exec.Prompt, redundant) {
				t.Errorf("redundant follow-up prompt content: %s", redundant)
			}
		}
		if strings.Count(exec.Prompt, "fix edge case") != 1 {
			t.Error("reply content duplicated")
		}
		_, err := s.ManagedAction(ctx, p.Task.RootID, a.Task.ID, "from-task", ManagedInput{Completed: true, Message: "edge case fixed"})
		return err
	}
	s.Runner = runner
	revised.Task.SchedulerAdmitted = false
	if err := store.UpdateTask(ctx, revised.Task); err != nil {
		t.Fatal(err)
	}
	if err := s.executeTaskMessages(ctx, p.Task.RootID, a.Task.ID); err != nil {
		t.Fatal(err)
	}
	latest, err := store.GetDetail(ctx, a.Task.ID)
	if err != nil || latest.Task.Status != StatusSuccess || len(latest.StageRuns) != len(done.StageRuns)+1 || latest.StageRuns[1].Result != done.StageRuns[1].Result {
		t.Fatalf("follow-up did not complete with preserved history: %+v err=%v", latest, err)
	}
	inbox, err := store.Inbox(ctx, a.Task.ID)
	if err != nil || len(inbox) != 0 {
		t.Fatalf("successful follow-up did not consume message: %+v err=%v", inbox, err)
	}
}

func TestPlanBatchAtomicAndRecovery(t *testing.T) {
	ctx := context.Background()
	s, store, p := orchestrationFixture(t)
	_, e := s.CreateGroupTasks(ctx, p.Task.RootID, p.Task.GroupID, []ChildPlanItem{{Ref: "a", CreateTaskInput: CreateTaskInput{TaskTemplateID: p.Task.TaskTemplateID, Input: "a", DependsOn: []string{"b"}}}, {Ref: "b", CreateTaskInput: CreateTaskInput{TaskTemplateID: p.Task.TaskTemplateID, Input: "b", DependsOn: []string{"a"}}}})
	if e == nil {
		t.Fatal("cyclic batch accepted")
	}
	g, _ := s.GroupGraph(ctx, p.Task.RootID, p.Task.GroupID)
	if len(g.Tasks) != 0 || g.Group.PlanVersion != 0 {
		t.Fatal("failed batch partially persisted")
	}
	g, e = s.CreateGroupTasks(ctx, p.Task.RootID, p.Task.GroupID, []ChildPlanItem{{Ref: "a", CreateTaskInput: CreateTaskInput{TaskTemplateID: p.Task.TaskTemplateID, Input: "a"}}, {Ref: "b", CreateTaskInput: CreateTaskInput{TaskTemplateID: p.Task.TaskTemplateID, Input: "b", DependsOn: []string{"a"}}}})
	if e != nil || len(g.Tasks) != 2 {
		t.Fatalf("batch failed: %v", e)
	}
	c := g.Tasks[0].Task
	c.Status = StatusRunning
	c.SchedulerAdmitted = true
	_ = store.UpdateTask(ctx, c)
	if e = store.recoverManaged(); e != nil {
		t.Fatal(e)
	}
	c, _ = store.GetTask(ctx, c.ID)
	if c.Status != StatusFail || c.SchedulerAdmitted {
		t.Fatal("interrupted task blindly resumed")
	}
	inbox, e := store.Inbox(ctx, p.Task.GroupID)
	if e != nil || len(inbox) != 1 {
		t.Fatalf("missing recovery notification: %v", e)
	}
}

func TestSchedulerDoesNotClaimFollowupBeforePreviousRunnerReturns(t *testing.T) {
	ctx := context.Background()
	s, store, p := orchestrationFixture(t)
	c := child(t, s, p, "implementation")
	approve(t, s, p)
	s.Runner = &fakeRunner{}
	s.running = map[string]bool{p.Task.RootID + "/" + c.Task.ID: true}
	if e := s.schedule(ctx, p.Task.RootID); e != nil {
		t.Fatal(e)
	}
	state, e := store.GetTask(ctx, c.Task.ID)
	if e != nil {
		t.Fatal(e)
	}
	if state.SchedulerAdmitted || state.Status != StatusQueued {
		t.Fatalf("claimed still-active task: %#v", state)
	}
}

func TestWorktreePreparationFailureNotifiesParentAndCanBeCorrected(t *testing.T) {
	ctx := context.Background()
	s, store, p := orchestrationFixture(t)
	c := child(t, s, p, "implementation")
	yes := true
	if _, e := s.PatchTask(ctx, p.Task.RootID, c.Task.ID, TaskPatch{CreateWorktree: &yes}); e != nil {
		t.Fatal(e)
	}
	approve(t, s, p)
	s.Runner = &fakeRunner{worktreeErr: errors.New("branch already exists")}
	if e := s.schedule(ctx, p.Task.RootID); e != nil {
		t.Fatal(e)
	}
	state, _ := store.GetTask(ctx, c.Task.ID)
	if state.Status != StatusFail || state.SchedulerAdmitted {
		t.Fatal("preparation failure did not stop task")
	}
	inbox, e := store.Inbox(ctx, p.Task.GroupID)
	if e != nil || len(inbox) != 1 {
		t.Fatal("parent not notified")
	}
	branch := "feature/new-name"
	fixed, e := s.PatchTask(ctx, p.Task.RootID, c.Task.ID, TaskPatch{WorktreeBranch: &branch})
	if e != nil {
		t.Fatal(e)
	}
	if fixed.Task.Status != StatusPending || fixed.Task.Published || fixed.Task.BlockReason != "" {
		t.Fatal("corrected task was not returned to unpublished state")
	}
}

func TestManagedChildUsesMultipleTemplateStages(t *testing.T) {
	ctx := context.Background()
	s, store, p := orchestrationFixture(t)
	tmpl, _ := s.Templates.GetTaskTemplate(p.Task.TaskTemplateID)
	tmpl.ID = ""
	tmpl.Stages[1].Snapshot.AutoAdvance = true
	tmpl.Stages = append(tmpl.Stages, TaskTemplateStage{Position: 2, Snapshot: StageTemplate{Name: "Deliver", Role: RoleAgent, Agent: "codex", PromptTemplate: "DELIVERY INSTRUCTIONS {previous_input}"}})
	saved, err := s.Templates.SaveTaskTemplate(tmpl)
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.CreateTask(ctx, CreateTaskInput{RootID: p.Task.RootID, GroupID: p.Task.GroupID, TaskTemplateID: saved.ID, Input: "three stages"})
	if err != nil {
		t.Fatal(err)
	}
	approve(t, s, p)
	calls := 0
	runner := &orchestrationRunner{}
	runner.run = func(exec AgentStageExecution) error {
		calls++
		if exec.Run.StageIndex == 2 {
			if !strings.Contains(exec.Prompt, "DELIVERY INSTRUCTIONS") {
				t.Error("new stage instructions omitted in reused session")
			}
			_, err := s.ManagedAction(ctx, p.Task.RootID, c.Task.ID, "from-task", ManagedInput{Completed: true, Message: "final delivery"})
			return err
		}
		return nil
	}
	s.Runner = runner
	// Drive execution synchronously; async scheduler calls see the task as active.
	s.running = map[string]bool{p.Task.RootID + "/" + c.Task.ID: true}
	for i := 0; i < 2; i++ {
		current, _ := store.GetTask(ctx, c.Task.ID)
		current.Status = StatusRunning
		current.SchedulerAdmitted = true
		if err := store.UpdateTask(ctx, current); err != nil {
			t.Fatal(err)
		}
		if err := s.executeTask(ctx, p.Task.RootID, c.Task.ID); err != nil {
			t.Fatal(err)
		}
	}
	current, _ := store.GetTask(ctx, c.Task.ID)
	if calls != 2 || current.CurrentStageIndex != 2 || current.Status != StatusSuccess {
		t.Fatalf("template stages not honored: calls=%d task=%+v", calls, current)
	}
}
