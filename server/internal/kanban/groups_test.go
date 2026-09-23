package kanban

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type groupTestRunner struct {
	fakeRunner
	busy bool
	turn func(TaskGroup, string) error
}

func (r *groupTestRunner) ValidateGroupSession(_ context.Context, _, key string) error {
	if key == "missing" {
		return errors.New("session missing")
	}
	return nil
}
func (r *groupTestRunner) GroupSessionBusy(string, string) bool { return r.busy }
func (r *groupTestRunner) RunGroupTurn(_ context.Context, g TaskGroup, p string) error {
	if r.turn != nil {
		return r.turn(g, p)
	}
	return nil
}
func groupFixture(t *testing.T) (*Service, *TaskStore, TaskGroup) {
	t.Helper()
	s, store, base := orchestrationFixture(t)
	s.Runner = &groupTestRunner{}
	g, e := s.CreateGroup(context.Background(), TaskGroup{RootID: base.Task.RootID, SessionKey: "ordinary-chat", Title: "Feature"})
	if e != nil {
		t.Fatal(e)
	}
	s.Runner = nil
	return s, store, g
}
func groupTask(t *testing.T, s *Service, g TaskGroup, input string, deps ...string) TaskDetail {
	t.Helper()
	d, e := s.CreateTask(context.Background(), CreateTaskInput{RootID: g.RootID, GroupID: g.ID, TaskTemplateID: groupTemplateID(t, s), Input: input, DependsOn: deps})
	if e != nil {
		t.Fatal(e)
	}
	return d
}
func groupTemplateID(t *testing.T, s *Service) string {
	t.Helper()
	templates, err := s.Templates.ListTaskTemplates()
	if err != nil || len(templates) == 0 {
		t.Fatalf("templates: %v", err)
	}
	return templates[0].ID
}

func TestTaskCannotOwnAnOrchestrationPlan(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	child := groupTask(t, s, g, "group task")
	before, err := store.getGroup(ctx, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"publish", "approve-plan", "complete"} {
		if _, err := s.ManagedAction(ctx, g.RootID, child.Task.ID, action, ManagedInput{PlanVersion: &before.PlanVersion}); err == nil {
			t.Fatal("task accepted group operation", action)
		}
	}
	if _, err := s.CreateGroupTasks(ctx, g.RootID, child.Task.ID, []ChildPlanItem{{Ref: "nested", CreateTaskInput: CreateTaskInput{TaskTemplateID: child.Task.TaskTemplateID, Input: "nested"}}}); err == nil {
		t.Fatal("task accepted nested plan")
	}
	after, err := store.getGroup(ctx, g.ID)
	if err != nil || after != before {
		t.Fatalf("rejected operations changed group: %+v %v", after, err)
	}
}

func TestGroupRequiresExplicitTemplate(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	before, _ := store.getGroup(ctx, g.ID)
	for _, templateID := range []string{"", "missing"} {
		if _, err := s.CreateTask(ctx, CreateTaskInput{RootID: g.RootID, GroupID: g.ID, TaskTemplateID: templateID, Input: "invalid"}); err == nil {
			t.Fatal("invalid template accepted")
		}
	}
	after, _ := store.getGroup(ctx, g.ID)
	if before.PlanVersion != after.PlanVersion {
		t.Fatal("failed creation changed plan")
	}
	d := groupTask(t, s, g, "explicit")
	if d.Task.TaskTemplateID != groupTemplateID(t, s) || d.Task.GroupID != g.ID {
		t.Fatal("explicit group template ignored")
	}
	if _, err := s.CreateGroupTasks(ctx, g.RootID, g.ID, []ChildPlanItem{
		{Ref: "valid", CreateTaskInput: CreateTaskInput{TaskTemplateID: d.Task.TaskTemplateID, Input: "valid"}},
		{Ref: "invalid", CreateTaskInput: CreateTaskInput{Input: "no template"}},
	}); err == nil {
		t.Fatal("batch allowed missing template")
	}
	graph, err := s.GroupGraph(ctx, g.RootID, g.ID)
	if err != nil || len(graph.Tasks) != 1 {
		t.Fatalf("failed batch persisted tasks: %v", err)
	}
}
func TestGroupPublicationDependenciesAndNewInstructions(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	a := groupTask(t, s, g, "a")
	b := groupTask(t, s, g, "b", a.Task.ID)
	graph, _ := s.GroupGraph(ctx, g.RootID, g.ID)
	if _, e := s.GroupAction(ctx, g.RootID, g.ID, "publish", ManagedInput{PlanVersion: &graph.Group.PlanVersion}); e != nil {
		t.Fatal(e)
	}
	fresh, _ := store.GetTask(ctx, a.Task.ID)
	if fresh.Published {
		t.Fatal("first publication skipped approval")
	}
	stale := 0
	if _, e := s.GroupAction(ctx, g.RootID, g.ID, "approve-plan", ManagedInput{PlanVersion: &stale}); e == nil {
		t.Fatal("stale approval accepted")
	}
	if _, e := s.GroupAction(ctx, g.RootID, g.ID, "approve-plan", ManagedInput{PlanVersion: &graph.Group.PlanVersion}); e != nil {
		t.Fatal(e)
	}
	fresh, _ = store.GetTask(ctx, a.Task.ID)
	if !s.managedReady(ctx, store, fresh) {
		t.Fatal("root task not ready")
	}
	blocked, _ := store.GetTask(ctx, b.Task.ID)
	if s.managedReady(ctx, store, blocked) {
		t.Fatal("dependency ignored")
	}
	deps := []string{b.Task.ID}
	if _, e := s.PatchTask(ctx, g.RootID, a.Task.ID, TaskPatch{DependsOn: &deps}); e == nil {
		t.Fatal("cycle accepted")
	}
	// Complete one task through the same agent result path used for legacy tasks.
	execRunner := &orchestrationRunner{run: func(exec AgentStageExecution) error {
		_, e := s.ManagedAction(ctx, g.RootID, a.Task.ID, "from-task", ManagedInput{Completed: true, Message: "done"})
		return e
	}}
	s.Runner = execRunner
	s.running = map[string]bool{g.RootID + "/" + a.Task.ID: true, g.RootID + "/" + b.Task.ID: true}
	fresh.Status = StatusRunning
	fresh.SchedulerAdmitted = true
	_ = store.UpdateTask(ctx, fresh)
	if e := s.executeTask(ctx, g.RootID, a.Task.ID); e != nil {
		t.Fatal(e)
	}
	s.Runner = nil
	done, _ := store.GetDetail(ctx, a.Task.ID)
	if done.Task.Status != StatusSuccess {
		t.Fatal("grouped task did not complete")
	}
	if _, e := s.ManagedAction(ctx, g.RootID, a.Task.ID, "to-task", ManagedInput{Message: "fix"}); e != nil {
		t.Fatal(e)
	}
	blocked, _ = store.GetTask(ctx, b.Task.ID)
	if blocked.BlockReason != "" || s.managedReady(ctx, store, blocked) {
		t.Fatal("downstream must wait for dependency without a review state")
	}
}
func TestGroupMessagesReturnToOrdinarySession(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	a := groupTask(t, s, g, "a")
	if _, e := s.ManagedAction(ctx, g.RootID, a.Task.ID, "from-task", ManagedInput{Message: "Need a decision"}); e != nil {
		t.Fatal(e)
	}
	inbox, _ := store.Inbox(ctx, g.ID)
	if len(inbox) != 1 {
		t.Fatal("message did not target group")
	}
	called := make(chan TaskGroup, 1)
	r := &groupTestRunner{busy: true, turn: func(g TaskGroup, prompt string) error {
		if !strings.Contains(prompt, "Need a decision") {
			t.Error("message missing")
		}
		called <- g
		return nil
	}}
	s.Runner = r
	s.opMu.Lock()
	e := s.refreshGroups(ctx, store)
	s.opMu.Unlock()
	if e != nil {
		t.Fatal(e)
	}
	select {
	case <-called:
		t.Fatal("interrupted busy user conversation")
	default:
	}
	r.busy = false
	s.opMu.Lock()
	e = s.refreshGroups(ctx, store)
	s.opMu.Unlock()
	if e != nil {
		t.Fatal(e)
	}
	select {
	case got := <-called:
		if got.SessionKey != "ordinary-chat" {
			t.Fatal("wrong source")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no parent session delivery")
	}
	s.Close()
}
func TestGroupAtomicPlanAndAcceptance(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	if _, e := s.CreateGroupTasks(ctx, g.RootID, g.ID, []ChildPlanItem{{Ref: "a", CreateTaskInput: CreateTaskInput{TaskTemplateID: groupTemplateID(t, s), Input: "a", DependsOn: []string{"b"}}}, {Ref: "b", CreateTaskInput: CreateTaskInput{TaskTemplateID: groupTemplateID(t, s), Input: "b", DependsOn: []string{"a"}}}}); e == nil {
		t.Fatal("cyclic group plan accepted")
	}
	graph, _ := s.GroupGraph(ctx, g.RootID, g.ID)
	if len(graph.Tasks) != 0 || graph.Group.PlanVersion != 0 {
		t.Fatal("failed plan persisted")
	}
	if _, e := s.CreateGroupTasks(ctx, g.RootID, g.ID, []ChildPlanItem{{Ref: "a", CreateTaskInput: CreateTaskInput{TaskTemplateID: groupTemplateID(t, s), Input: "a"}}, {Ref: "b", CreateTaskInput: CreateTaskInput{TaskTemplateID: groupTemplateID(t, s), Input: "b", DependsOn: []string{"a"}}}}); e != nil {
		t.Fatal(e)
	}
	graph, _ = s.GroupGraph(ctx, g.RootID, g.ID)
	if _, e := s.GroupAction(ctx, g.RootID, g.ID, "approve-plan", ManagedInput{PlanVersion: &graph.Group.PlanVersion}); e != nil {
		t.Fatal(e)
	}
	if _, e := s.GroupAction(ctx, g.RootID, g.ID, "complete", ManagedInput{PlanVersion: &graph.Group.PlanVersion, Message: "accept"}); e == nil {
		t.Fatal("accepted unfinished tasks")
	}
	for _, d := range graph.Tasks {
		task, _ := store.GetTask(ctx, d.Task.ID)
		task.Status = StatusSuccess
		task.CompletedAt = "now"
		_ = store.UpdateTask(ctx, task)
	}
	if _, e := s.GroupAction(ctx, g.RootID, g.ID, "complete", ManagedInput{PlanVersion: &graph.Group.PlanVersion, Message: "verified all outputs"}); e != nil {
		t.Fatal(e)
	}
	final, _ := store.getGroup(ctx, g.ID)
	if final.Status != "success" {
		t.Fatal("group not completed")
	}
}

func TestGroupCancelStopsTasksAndRejectsFurtherExecution(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	a := groupTask(t, s, g, "a")
	if _, e := s.GroupAction(ctx, g.RootID, g.ID, "cancel", ManagedInput{Message: "user cancelled"}); e != nil {
		t.Fatal(e)
	}
	current, _ := store.GetTask(ctx, a.Task.ID)
	if current.Status != StatusCancelled {
		t.Fatal("group cancellation left task active")
	}
	if _, e := s.ManagedAction(ctx, g.RootID, a.Task.ID, "to-task", ManagedInput{Message: "try again"}); e == nil {
		t.Fatal("terminal group accepted execution")
	}
	if _, e := s.GroupAction(ctx, g.RootID, g.ID, "cancel", ManagedInput{Message: "user cancelled"}); e != nil {
		t.Fatal("cancel retry should be safe", e)
	}
}
func TestGroupRecoveryPreservesPendingMessages(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	a := groupTask(t, s, g, "a")
	if _, e := s.ManagedAction(ctx, g.RootID, a.Task.ID, "from-task", ManagedInput{Message: "question"}); e != nil {
		t.Fatal(e)
	}
	if _, e := store.db.ExecContext(ctx, `UPDATE task_groups SET status='coordinating' WHERE id=?`, g.ID); e != nil {
		t.Fatal(e)
	}
	if e := store.recoverManaged(); e != nil {
		t.Fatal(e)
	}
	current, _ := store.getGroup(ctx, g.ID)
	messages, _ := store.Inbox(ctx, g.ID)
	if current.Status != "blocked" || len(messages) != 1 {
		t.Fatal("interrupted coordination should block without losing messages")
	}
}

func TestGroupConcurrencyDoesNotCountOtherGroupsUsingSameTemplate(t *testing.T) {
	s, _, _ := groupFixture(t)
	template := TaskTemplate{ID: "shared", MaxConcurrency: 1}
	candidate := Task{ID: "candidate", GroupID: "group-a", TaskTemplateID: "shared", CreateWorktree: true}
	other := Task{ID: "other", GroupID: "group-b", TaskTemplateID: "shared", CreateWorktree: true, SchedulerAdmitted: true, Status: StatusRunning}
	if !s.hasSlot(candidate, template, []Task{other}) {
		t.Fatal("unrelated group consumed candidate concurrency")
	}
	other.GroupID = "group-a"
	if s.hasSlot(candidate, template, []Task{other}) {
		t.Fatal("same group exceeded concurrency")
	}
	candidate.CreateWorktree = false
	other.CreateWorktree = false
	other.GroupID = "group-b"
	if s.hasSlot(candidate, template, []Task{other}) {
		t.Fatal("shared workspaces must remain serialized across groups")
	}
}

func TestSeparateGroupCreations(t *testing.T) {
	s, _, g := groupFixture(t)
	s.Runner = &groupTestRunner{}
	another, err := s.CreateGroup(context.Background(), TaskGroup{RootID: g.RootID, SessionKey: g.SessionKey, Title: g.Title})
	if err != nil {
		t.Fatal(err)
	}
	if another.ID == g.ID {
		t.Fatal("separate creation reused group")
	}
}

func TestReplyResumesWaitingTask(t *testing.T) {
	for _, tc := range []struct {
		name, state string
		stage       int
		want        string
	}{
		{"waiting for answer", StatusWaitingUser, 1, StatusQueued},
		{"execution failed", StatusFail, 1, StatusQueued},
		{"already completed", StatusSuccess, 1, StatusQueued},
		{"not started", StatusPending, 0, StatusQueued},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			s, store, g := groupFixture(t)
			d := groupTask(t, s, g, "implement")
			graph, _ := s.GroupGraph(ctx, g.RootID, g.ID)
			if _, err := s.GroupAction(ctx, g.RootID, g.ID, "approve-plan", ManagedInput{PlanVersion: &graph.Group.PlanVersion}); err != nil {
				t.Fatal(err)
			}
			task, _ := store.GetTask(ctx, d.Task.ID)
			task.CurrentStageIndex = tc.stage
			task.Status = tc.state
			if err := store.UpdateTask(ctx, task); err != nil {
				t.Fatal(err)
			}
			if _, err := s.ManagedAction(ctx, g.RootID, task.ID, "to-task", ManagedInput{Message: "Use page 1"}); err != nil {
				t.Fatal(err)
			}
			all, err := store.ListTasks(ctx, ListTasksOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if err = s.refreshManaged(ctx, store, all); err != nil {
				t.Fatal(err)
			}
			got, err := store.GetTask(ctx, task.ID)
			if err != nil || got.Status != tc.want {
				t.Fatalf("status=%s want=%s err=%v", got.Status, tc.want, err)
			}
			if tc.want == StatusQueued && got.BlockReason != "" {
				t.Fatal("reply did not clear waiting reason")
			}
			inbox, _ := store.Inbox(ctx, task.ID)
			if len(inbox) != 1 {
				t.Fatal("reply must remain available for execution")
			}
			for _, action := range []string{"complete", "pause", "resume", "continue", "retry", "rework", "confirm-result", "block", "yield", "fail", "start"} {
				if _, err := s.ManagedAction(ctx, g.RootID, task.ID, action, ManagedInput{}); err == nil {
					t.Fatalf("removed action accepted: %s", action)
				}
			}
		})
	}
}

func TestReplyBeforeReportingTurnExits(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	d := groupTask(t, s, g, "implement")
	tmpl, err := s.TaskExecutionTemplate(d.Task)
	if err != nil {
		t.Fatal(err)
	}
	task := d.Task
	task.SchedulerAdmitted = true
	task.Published = true
	moved, err := s.moveTo(ctx, store, task, tmpl, 1, "test", "", "")
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.LatestStageRun(ctx, task.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ManagedAction(ctx, g.RootID, task.ID, "from-task", ManagedInput{Message: "Need answer"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ManagedAction(ctx, g.RootID, task.ID, "to-task", ManagedInput{Message: "Here is the answer"}); err != nil {
		t.Fatal(err)
	}
	if err = s.finishManagedRun(ctx, store, moved.Task, run, nil, nil); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetTask(ctx, task.ID)
	if err != nil || got.Status != StatusPending || got.BlockReason != "" {
		t.Fatalf("reply lost at turn completion: %+v err=%v", got, err)
	}
	inbox, _ := store.Inbox(ctx, task.ID)
	if len(inbox) != 1 {
		t.Fatal("reply was acknowledged before execution")
	}
}

func TestMessageDeliveryAutomaticallyAcknowledgesOnlySuccessfulBatch(t *testing.T) {
	for _, fails := range []bool{false, true} {
		name := "success"
		if fails {
			name = "failure"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			s, store, g := groupFixture(t)
			task := groupTask(t, s, g, "worker")
			if _, err := s.ManagedAction(ctx, g.RootID, task.Task.ID, "from-task", ManagedInput{Message: "first report"}); err != nil {
				t.Fatal(err)
			}
			graph, err := s.GroupGraph(ctx, g.RootID, g.ID)
			if err != nil || len(graph.Messages) != 1 {
				t.Fatal("report not routed", err)
			}
			// Reading messages is observational: it must not consume them.
			again, _ := s.GroupGraph(ctx, g.RootID, g.ID)
			if len(again.Messages) != 1 {
				t.Fatal("query consumed report")
			}
			turn := "test-turn"
			if _, err = store.db.ExecContext(ctx, `UPDATE task_events SET stage_run_id=? WHERE id=?`, turn, graph.Messages[0].ID); err != nil {
				t.Fatal(err)
			}
			if _, err = store.db.ExecContext(ctx, `UPDATE task_groups SET status='coordinating' WHERE id=?`, g.ID); err != nil {
				t.Fatal(err)
			}
			runner := &groupTestRunner{turn: func(_ TaskGroup, prompt string) error {
				if strings.Contains(prompt, "Read mindfs -orchestration") || strings.Contains(prompt, "\nTask #") || strings.Contains(prompt, `"message"`) {
					t.Error("ordinary report contains redundant workflow, task list or JSON")
				}
				if !strings.Contains(prompt, "task_id="+task.Task.ID) {
					t.Error("sender ID missing")
				}
				if _, err := s.ManagedAction(ctx, g.RootID, task.Task.ID, "from-task", ManagedInput{Message: "second report"}); err != nil {
					t.Fatal(err)
				}
				if fails {
					return errors.New("delivery failed")
				}
				return nil
			}}
			s.workers.Add(1)
			s.runGroupTurn(ctx, store, runner, g, graph, turn, "test-key")
			inbox, err := store.Inbox(ctx, g.ID)
			if err != nil {
				t.Fatal(err)
			}
			want := 1
			if fails {
				want = 2
			}
			if len(inbox) != want {
				t.Fatalf("pending=%d want=%d", len(inbox), want)
			}
			if !fails && !strings.Contains(inbox[0].Payload, "second report") {
				t.Fatal("new message incorrectly acknowledged")
			}
			current, _ := store.getGroup(ctx, g.ID)
			if fails && (current.Status != "blocked" || current.BlockReason != "delivery failed") {
				t.Fatal("delivery failure not recorded")
			}
			if _, err := s.GroupAction(ctx, g.RootID, g.ID, "ack", ManagedInput{Message: graph.Messages[0].ID}); err == nil {
				t.Fatal("manual ack still accepted")
			}
		})
	}
}

func TestReportedQuestionDoesNotGenerateDuplicateParentNotification(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	d := groupTask(t, s, g, "implement")
	tmpl, err := s.TaskExecutionTemplate(d.Task)
	if err != nil {
		t.Fatal(err)
	}
	task := d.Task
	task.SchedulerAdmitted = true
	task.Published = true
	moved, err := s.moveTo(ctx, store, task, tmpl, 1, "test", "", "")
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.LatestStageRun(ctx, task.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ManagedAction(ctx, g.RootID, task.ID, "from-task", ManagedInput{Message: "Need answer"}); err != nil {
		t.Fatal(err)
	}
	// Parent processing can claim the report before the child turn has exited.
	if _, err = store.db.ExecContext(ctx, "UPDATE task_events SET stage_run_id=? WHERE task_id=? AND type='from-task'", "parent-turn", task.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.finishManagedRun(ctx, store, moved.Task, run, nil, nil); err != nil {
		t.Fatal(err)
	}
	messages, err := store.Inbox(ctx, g.ID)
	if err != nil || len(messages) != 1 || messages[0].Type != "from-task" {
		t.Fatalf("duplicate notification after explicit report: %+v err=%v", messages, err)
	}
	got, err := store.GetTask(ctx, task.ID)
	if err != nil || got.Status != StatusWaitingUser {
		t.Fatalf("reported task must wait for instructions: %+v err=%v", got, err)
	}
}

func TestDeliveryMessagesFinalizeOnlySuccessfulExecution(t *testing.T) {
	for _, tc := range []struct {
		name      string
		completed bool
		fails     bool
		followup  bool
		want      string
	}{
		{"ordinary report", false, false, false, StatusWaitingUser},
		{"delivery", true, false, false, StatusSuccess},
		{"delivery then execution failure", true, true, false, StatusFail},
		{"delivery then new instructions", true, false, true, StatusWaitingUser},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			s, store, g := groupFixture(t)

			d := groupTask(t, s, g, "implement")
			if _, err := s.ManagedAction(ctx, g.RootID, d.Task.ID, "from-task", ManagedInput{Message: "premature", Completed: true}); err == nil {
				t.Fatal("accepted delivery before execution")
			}
			task := d.Task
			task.Published = true
			task.Status = StatusRunning
			task.SchedulerAdmitted = true
			if err := store.UpdateTask(ctx, task); err != nil {
				t.Fatal(err)
			}
			s.Runner = &orchestrationRunner{run: func(exec AgentStageExecution) error {
				if _, err := s.ManagedAction(ctx, g.RootID, task.ID, "from-task", ManagedInput{Message: "verified output", Completed: tc.completed}); err != nil {
					return err
				}
				current, err := store.GetTask(ctx, task.ID)
				if err != nil || current.Status != StatusRunning || !current.SchedulerAdmitted {
					t.Fatalf("message prematurely released execution: %+v err=%v", current, err)
				}
				messages, err := store.Inbox(ctx, g.ID)
				if err != nil || (tc.completed && len(messages) != 0) || (!tc.completed && len(messages) != 1) {
					t.Fatalf("incorrect parent notification: %+v err=%v", messages, err)
				}
				if tc.followup {
					if _, err := s.ManagedAction(ctx, g.RootID, task.ID, "to-task", ManagedInput{Message: "also check boundaries"}); err != nil {
						return err
					}
				}
				if tc.fails {
					return errors.New("execution failed")
				}
				return nil
			}}
			if err := s.executeTask(ctx, g.RootID, task.ID); err != nil {
				t.Fatal(err)
			}
			current, err := store.GetTask(ctx, task.ID)
			if err != nil || current.Status != tc.want || current.SchedulerAdmitted {
				t.Fatalf("status=%s want=%s err=%v", current.Status, tc.want, err)
			}
			run, err := store.LatestStageRun(ctx, task.ID, 1)
			if err != nil {
				t.Fatal(err)
			}
			if tc.completed && !tc.fails && run.Result != "verified output" {
				t.Fatalf("delivery result not saved: %+v", run)
			}
			if tc.fails && run.Status != StageStatusFail {
				t.Fatalf("failed execution recorded as success: %+v", run)
			}
		})
	}
}

func TestStageDeliveryHonorsTemplateAndNotifiesForConfirmation(t *testing.T) {
	for _, tc := range []struct {
		name       string
		auto       bool
		nextRole   string
		wantStage  int
		wantStatus string
		wantNotice bool
	}{
		{"automatic agent stage", true, RoleAgent, 2, StatusQueued, false},
		{"parent confirmation", false, RoleAgent, 1, StatusWaitingUser, true},
		{"human input", true, RoleUser, 2, StatusWaitingUser, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			s, store, g := groupFixture(t)
			tmpl, err := s.Templates.GetTaskTemplate(groupTemplateID(t, s))
			if err != nil {
				t.Fatal(err)
			}
			tmpl.Stages[1].Snapshot.AutoAdvance = tc.auto
			tmpl.Stages = append(tmpl.Stages, TaskTemplateStage{Position: 2, Snapshot: StageTemplate{Name: "Next", Role: tc.nextRole, Agent: "codex"}})
			if _, err := s.Templates.SaveTaskTemplate(tmpl); err != nil {
				t.Fatal(err)
			}
			d := groupTask(t, s, g, "implement")
			task := d.Task
			task.Published = true
			task.Status = StatusRunning
			task.SchedulerAdmitted = true
			if err := store.UpdateTask(ctx, task); err != nil {
				t.Fatal(err)
			}
			s.Runner = &orchestrationRunner{run: func(exec AgentStageExecution) error {
				_, err := s.ManagedAction(ctx, g.RootID, task.ID, "from-task", ManagedInput{Message: "stage verified", Completed: true})
				return err
			}}
			s.running = map[string]bool{g.RootID + "/" + task.ID: true}
			if err := s.executeTask(ctx, g.RootID, task.ID); err != nil {
				t.Fatal(err)
			}
			current, err := store.GetTask(ctx, task.ID)
			if err != nil || current.CurrentStageIndex != tc.wantStage || current.Status != tc.wantStatus || current.CompletedAt != "" {
				t.Fatalf("stage delivery prematurely completed task or ignored template: %+v err=%v", current, err)
			}
			run, err := store.LatestStageRun(ctx, task.ID, 1)
			if err != nil || run.Result != "stage verified" {
				t.Fatalf("stage result lost: %+v err=%v", run, err)
			}
			messages, err := store.Inbox(ctx, g.ID)
			if err != nil || (tc.wantNotice && (len(messages) != 1 || messages[0].Type != "stage_confirmation_required")) || (!tc.wantNotice && len(messages) != 0) {
				t.Fatalf("incorrect confirmation notice: %+v err=%v", messages, err)
			}
			s.Runner = nil
			if !tc.auto {
				next, err := s.Next(ctx, MoveInput{RootID: g.RootID, TaskID: task.ID})
				if err != nil || next.Task.CurrentStageIndex != 2 || next.Task.Status == StatusSuccess {
					t.Fatalf("explicit confirmation did not advance stage: %+v err=%v", next, err)
				}
			} else if tc.nextRole == RoleUser {
				reply, err := s.ManagedAction(ctx, g.RootID, task.ID, "to-task", ManagedInput{Message: "please continue"})
				if err != nil || reply.Task.CurrentStageIndex != 2 || reply.Task.Status != StatusWaitingUser {
					t.Fatalf("ordinary reply bypassed human input: %+v err=%v", reply, err)
				}
			}
		})
	}
}

func TestSharedGroupContextEditing(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	d := groupTask(t, s, g, "worker")
	before, err := store.getGroup(ctx, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := s.UpdateGroupContext(ctx, g.RootID, g.ID, "new shared instructions", before.PlanVersion)
	if err != nil {
		t.Fatal(err)
	}
	if updated.ProjectContext != "new shared instructions" || updated.PlanVersion != before.PlanVersion+1 || updated.Title != before.Title || updated.SessionKey != before.SessionKey {
		t.Fatalf("unexpected group update: %+v", updated)
	}
	if _, err := s.UpdateGroupContext(ctx, g.RootID, g.ID, "stale", before.PlanVersion); err == nil {
		t.Fatal("stale overwrite accepted")
	}
	task, err := store.GetTask(ctx, d.Task.ID)
	if err != nil || task.Status != d.Task.Status {
		t.Fatalf("context edit changed task state: %+v %v", task, err)
	}
	cleared, err := s.UpdateGroupContext(ctx, g.RootID, g.ID, "", updated.PlanVersion)
	if err != nil || cleared.ProjectContext != "" {
		t.Fatalf("clear failed: %+v %v", cleared, err)
	}
	current, err := store.getGroup(ctx, g.ID)
	if err != nil || current.ProjectContext != "" {
		t.Fatal("context not persisted", err)
	}
	if _, err := store.db.ExecContext(ctx, "UPDATE task_groups SET status='success' WHERE id=?", g.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateGroupContext(ctx, g.RootID, g.ID, "terminal edit", current.PlanVersion); err == nil {
		t.Fatal("terminal group changed")
	}
}

func TestGroupRunNowBypassesOnlyConcurrency(t *testing.T) {
	for _, tc := range []struct {
		name           string
		groupStatus    string
		published      bool
		dependencyDone bool
		wantError      bool
	}{
		{"ready despite occupied shared workspace", "active", true, true, false},
		{"not published", "active", false, true, true},
		{"paused group", "paused", true, true, true},
		{"cancelled group", "cancelled", true, true, true},
		{"unfinished dependency", "active", true, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			s, store, g := groupFixture(t)
			upstream := groupTask(t, s, g, "dependency")
			busy := groupTask(t, s, g, "occupies shared workspace")
			target := groupTask(t, s, g, "start immediately", upstream.Task.ID)
			if _, err := store.db.ExecContext(ctx, "UPDATE task_groups SET published=?,status=? WHERE id=?", tc.published, tc.groupStatus, g.ID); err != nil {
				t.Fatal(err)
			}
			busy.Task.Status = StatusRunning
			busy.Task.SchedulerAdmitted = true
			if err := store.UpdateTask(ctx, busy.Task); err != nil {
				t.Fatal(err)
			}
			if tc.dependencyDone {
				upstream.Task.Status = StatusSuccess
				if err := store.UpdateTask(ctx, upstream.Task); err != nil {
					t.Fatal(err)
				}
			}
			target.Task.Published = tc.published
			target.Task.Status = StatusQueued
			if err := store.UpdateTask(ctx, target.Task); err != nil {
				t.Fatal(err)
			}
			tmpl, err := s.TaskExecutionTemplate(target.Task)
			if err != nil {
				t.Fatal(err)
			}
			if s.hasSlot(target.Task, tmpl, []Task{busy.Task}) {
				t.Fatal("test requires occupied concurrency slot")
			}
			_, err = s.RunNow(ctx, MoveInput{RootID: g.RootID, TaskID: target.Task.ID})
			if (err != nil) != tc.wantError {
				t.Fatalf("RunNow error=%v", err)
			}
			current, err := store.GetTask(ctx, target.Task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if tc.wantError {
				if current.SchedulerAdmitted || current.Status != StatusQueued {
					t.Fatal("rejected task was admitted")
				}
			} else if !current.SchedulerAdmitted || current.Status != StatusRunning {
				t.Fatal("manual start did not bypass concurrency")
			}
		})
	}
}

func TestGroupAcceptanceNotificationOncePerPlanVersion(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	d := groupTask(t, s, g, "worker")
	if _, err := store.db.ExecContext(ctx, "UPDATE task_groups SET published=1 WHERE id=?", g.ID); err != nil {
		t.Fatal(err)
	}
	finish := func() {
		t.Helper()
		if _, err := store.db.ExecContext(ctx, "UPDATE tasks SET published=1,current_stage_index=1,status='success',completed_at=? WHERE id=?", time.Now().UTC().Format(time.RFC3339Nano), d.Task.ID); err != nil {
			t.Fatal(err)
		}
	}
	refresh := func() {
		t.Helper()
		s.Runner = &groupTestRunner{busy: true}
		if err := s.refreshGroups(ctx, store); err != nil {
			t.Fatal(err)
		}
		s.Runner = nil
	}
	count := func(want int) {
		t.Helper()
		var n int
		if err := store.db.QueryRowContext(ctx, "SELECT count(*) FROM task_events WHERE task_id=? AND type='acceptance_ready'", g.ID).Scan(&n); err != nil || n != want {
			t.Fatalf("notifications=%d want=%d err=%v", n, want, err)
		}
	}
	finish()
	refresh()
	count(1)
	if _, err := store.db.ExecContext(ctx, "UPDATE task_events SET handled_at='handled' WHERE task_id=? AND type='acceptance_ready'", g.ID); err != nil {
		t.Fatal(err)
	}
	finish() // A timestamp change alone must not produce another notification.
	refresh()
	refresh()
	count(1)
	if _, err := s.ManagedAction(ctx, g.RootID, d.Task.ID, "to-task", ManagedInput{Message: "verify again"}); err != nil {
		t.Fatal(err)
	}
	finish()
	refresh()
	count(2)
	var payload string
	if err := store.db.QueryRowContext(ctx, "SELECT payload_json FROM task_events WHERE task_id=? AND type='acceptance_ready' ORDER BY created_at DESC LIMIT 1", g.ID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, "signature") || !strings.Contains(payload, "plan_version") {
		t.Fatal("unexpected notification metadata", payload)
	}
}

func TestParentPromptOmitsSharedContextAndAcceptanceMetadata(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	g.ProjectContext = "PRIVATE_SHARED_CONTEXT"
	graph := GroupGraph{Group: g, Messages: []TaskEvent{{ID: "event-test", TaskID: g.ID, Type: "acceptance_ready", Payload: `{"message":"Review all results","plan_version":1,"signature":"OLD_INTERNAL_SIGNATURE"}`},
		{ID: "report-event", TaskID: "task-test", Type: "from-task", Payload: `{"message":"Need confirmation","execution_id":"internal-execution"}`},
		{ID: "stage-event", TaskID: "task-test", Type: "stage_confirmation_required", Payload: `{"message":"Stage finished","result":"Tests passed"}`},
	}}
	runner := &groupTestRunner{turn: func(_ TaskGroup, prompt string) error {
		for _, unwanted := range []string{"Shared context", "PRIVATE_SHARED_CONTEXT", "signature", "OLD_INTERNAL_SIGNATURE", `"plan_version"`, "event_id", "event-test", "report-event", `"message"`, "internal-execution"} {
			if strings.Contains(prompt, unwanted) {
				t.Errorf("internal/context data in prompt: %s", unwanted)
			}
		}
		for _, expected := range []string{"task_id=task-test", "Need confirmation", "Stage finished", "Tests passed"} {
			if !strings.Contains(prompt, expected) {
				t.Errorf("missing message content: %s", expected)
			}
		}
		if !strings.Contains(prompt, "Review all results") || !strings.Contains(prompt, "plan_version=") {
			t.Error("review instructions or current plan version missing")
		}
		return nil
	}}
	s.workers.Add(1)
	s.runGroupTurn(ctx, store, runner, g, graph, "test-turn", "test-key")
}
