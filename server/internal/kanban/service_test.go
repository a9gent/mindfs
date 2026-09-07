package kanban

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"mindfs/server/internal/fs"
)

type testRoots struct {
	root fs.RootInfo
}

func (r testRoots) GetRoot(rootID string) (fs.RootInfo, error) {
	return r.root, nil
}

func (r testRoots) ListRoots() []fs.RootInfo {
	return []fs.RootInfo{r.root}
}

type fakeRunner struct {
	mu                   sync.Mutex
	execs                []AgentStageExecution
	prompts              []string
	runErr               error
	worktreeErr          error
	worktreeBranchMode   string
	worktreeBranch       string
	worktreeName         string
	worktreeCreateCalled bool
}

func (r *fakeRunner) CreateTaskWorktree(ctx context.Context, rootID, name, branchMode, branch string) (WorktreeInfo, error) {
	r.mu.Lock()
	r.worktreeBranchMode = branchMode
	r.worktreeBranch = branch
	r.worktreeName = name
	r.worktreeCreateCalled = true
	r.mu.Unlock()
	if r.worktreeErr != nil {
		return WorktreeInfo{}, r.worktreeErr
	}
	return WorktreeInfo{RootID: "wt-root", Path: filepath.Join(os.TempDir(), name)}, nil
}

func (r *fakeRunner) EnsureAgentSession(ctx context.Context, exec AgentStageExecution) (string, error) {
	return "session-" + exec.Run.ID, nil
}

func (r *fakeRunner) RunAgentStage(ctx context.Context, exec AgentStageExecution) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.execs = append(r.execs, exec)
	r.prompts = append(r.prompts, exec.Prompt)
	return r.runErr
}

func (r *fakeRunner) TaskUpdated(rootID string, detail TaskDetail) {}

func TestTaskTemplateStoreSeedsBundledTemplatesWhenUserFileMissing(t *testing.T) {
	dir := t.TempDir()
	bundledPath := filepath.Join(t.TempDir(), taskTemplateFile)
	bundled := []TaskTemplate{{
		ID:             "tmpl_default",
		Name:           "Default task",
		MaxConcurrency: 2,
		Stages: []TaskTemplateStage{{
			ID:       "stage_default",
			Position: 0,
			Snapshot: StageTemplate{
				ID:   "stage_user",
				Name: "Describe",
				Role: RoleUser,
			},
		}},
	}}
	data, err := json.MarshalIndent(bundled, "", "  ")
	if err != nil {
		t.Fatalf("marshal bundled templates: %v", err)
	}
	if err := os.WriteFile(bundledPath, append(data, '\n'), 0o644); err != nil {
		t.Fatalf("write bundled templates: %v", err)
	}

	previous := bundledTaskTemplatePaths
	bundledTaskTemplatePaths = func() []string { return []string{bundledPath} }
	defer func() { bundledTaskTemplatePaths = previous }()

	store := NewTemplateStoreAt(dir)
	items, err := store.ListTaskTemplates()
	if err != nil {
		t.Fatalf("ListTaskTemplates: %v", err)
	}
	if len(items) != 1 || items[0].ID != "tmpl_default" {
		t.Fatalf("templates = %#v, want bundled default", items)
	}
	if _, err := os.Stat(filepath.Join(dir, taskTemplateFile)); err != nil {
		t.Fatalf("user task template file not seeded: %v", err)
	}
}

func TestTaskTemplateStoreDoesNotSeedWhenUserFileExists(t *testing.T) {
	cases := []struct {
		name     string
		contents string
		wantFile string
	}{
		{name: "empty array", contents: "[]\n", wantFile: "[]"},
		{name: "empty file", contents: "", wantFile: ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, taskTemplateFile), []byte(tc.contents), 0o644); err != nil {
				t.Fatalf("write user templates: %v", err)
			}
			bundledPath := filepath.Join(t.TempDir(), taskTemplateFile)
			if err := os.WriteFile(bundledPath, []byte(`[{"id":"tmpl_default","name":"Default task","max_concurrency":1,"stages":[{"id":"stage_default","position":0,"snapshot":{"id":"stage_user","name":"Describe","role":"user"}}]}]`), 0o644); err != nil {
				t.Fatalf("write bundled templates: %v", err)
			}

			previous := bundledTaskTemplatePaths
			bundledTaskTemplatePaths = func() []string { return []string{bundledPath} }
			defer func() { bundledTaskTemplatePaths = previous }()

			store := NewTemplateStoreAt(dir)
			items, err := store.ListTaskTemplates()
			if err != nil {
				t.Fatalf("ListTaskTemplates: %v", err)
			}
			if len(items) != 0 {
				t.Fatalf("templates = %#v, want no seed", items)
			}
			data, err := os.ReadFile(filepath.Join(dir, taskTemplateFile))
			if err != nil {
				t.Fatalf("read user templates: %v", err)
			}
			if got := strings.TrimSpace(string(data)); got != tc.wantFile {
				t.Fatalf("user file = %q, want %q", got, tc.wantFile)
			}
		})
	}
}

func TestTemplateStoreJSONAndFirstStageValidation(t *testing.T) {
	dir := t.TempDir()
	store := NewTemplateStoreAt(dir)
	stage, err := store.SaveStageTemplate(StageTemplate{
		Name:           "Describe",
		Role:           RoleUser,
		PromptTemplate: "Describe the task",
	})
	if err != nil {
		t.Fatalf("SaveStageTemplate: %v", err)
	}
	if stage.ID == "" {
		t.Fatalf("stage ID empty")
	}
	if _, err := os.Stat(filepath.Join(dir, stageTemplateFile)); err != nil {
		t.Fatalf("stage template file missing: %v", err)
	}
	_, err = store.SaveTaskTemplate(TaskTemplate{
		Name: "Bad",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name: "Agent",
				Role: RoleAgent,
			},
		}},
	})
	if err == nil {
		t.Fatalf("SaveTaskTemplate accepted non-user first stage")
	}
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Good",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: stage,
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	if tmpl.MaxConcurrency != 1 {
		t.Fatalf("MaxConcurrency = %d, want 1", tmpl.MaxConcurrency)
	}
}

func TestCreateTaskAutoAdvanceControlsQueueAdmission(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})

	manual, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Manual",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:  "Fix",
				Role:  RoleAgent,
				Agent: "codex",
				Model: "gpt-5",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate manual: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: manual.ID, Input: "broken button"})
	if err != nil {
		t.Fatalf("CreateTask manual: %v", err)
	}
	if detail.Task.Status != StatusWaitingUser || detail.Task.SchedulerAdmitted {
		t.Fatalf("manual task status=%s admitted=%t, want waiting_user/not admitted", detail.Task.Status, detail.Task.SchedulerAdmitted)
	}
	if len(detail.StageRuns) != 1 || detail.StageRuns[0].Input != "broken button" {
		t.Fatalf("stage input not stored in run: %#v", detail.StageRuns)
	}
	next, err := svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID, Reason: "ready"})
	if err != nil {
		t.Fatalf("Next manual: %v", err)
	}
	if next.Task.Status != StatusQueued {
		t.Fatalf("after next status=%s, want queued", next.Task.Status)
	}

	auto, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Auto",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: true,
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate auto: %v", err)
	}
	autoDetail, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: auto.ID, Input: "ship it"})
	if err != nil {
		t.Fatalf("CreateTask auto: %v", err)
	}
	if autoDetail.Task.Status != StatusQueued {
		t.Fatalf("auto task status=%s, want queued", autoDetail.Task.Status)
	}
	if autoDetail.StageRuns[0].Status != StageStatusApproved {
		t.Fatalf("auto first run status=%s, want approved", autoDetail.StageRuns[0].Status)
	}
}

func TestNextRequiresCurrentUserInputWhenTargetReferencesIt(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	runner := &fakeRunner{}
	svc.SetRunner(runner)
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Input required",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:           "Fix",
				Role:           RoleAgent,
				Agent:          "codex",
				Model:          "gpt-5",
				PromptTemplate: "Fix this:\n{previous_input}",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: ""})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if _, err := svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID}); err == nil {
		t.Fatalf("Next with empty input succeeded, want error")
	}
	detail, err = svc.GetTask(ctx, root.ID, detail.Task.ID)
	if err != nil {
		t.Fatalf("GetTask: %v", err)
	}
	if detail.Task.CurrentStageIndex != 0 || detail.Task.Status != StatusWaitingUser {
		t.Fatalf("task stage/status = %d/%s, want 0/%s", detail.Task.CurrentStageIndex, detail.Task.Status, StatusWaitingUser)
	}
	runner.mu.Lock()
	execCount := len(runner.execs)
	runner.mu.Unlock()
	if execCount != 0 {
		t.Fatalf("agent exec count = %d, want 0", execCount)
	}
}

func TestNextAllowsEmptyInputWhenTargetDoesNotReferenceIt(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	runner := &fakeRunner{}
	svc.SetRunner(runner)
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Input optional",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Gate",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:           "Static",
				Role:           RoleAgent,
				Agent:          "codex",
				Model:          "gpt-5",
				PromptTemplate: "Run the static check.",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: ""})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	detail, err = svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID})
	if err != nil {
		t.Fatalf("Next with empty input: %v", err)
	}
	if detail.Task.CurrentStageIndex != 1 {
		t.Fatalf("current stage = %d, want 1", detail.Task.CurrentStageIndex)
	}
}

func TestNextRequiresCurrentInputFromAgentStageWhenTargetReferencesIt(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	runner := &fakeRunner{}
	svc.SetRunner(runner)
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Agent input required",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:           "Fix",
				Role:           RoleAgent,
				AutoAdvance:    false,
				Agent:          "codex",
				Model:          "gpt-5",
				PromptTemplate: "Fix this:\n{previous_input}",
			},
		}, {
			Position: 2,
			Snapshot: StageTemplate{
				Name:           "Review",
				Role:           RoleAgent,
				Agent:          "codex",
				Model:          "gpt-5",
				PromptTemplate: "Review this:\n{previous_input}",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "first"})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	detail, err = svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID})
	if err != nil {
		t.Fatalf("Next to agent: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		detail, err = svc.GetTask(ctx, root.ID, detail.Task.ID)
		if err == nil && detail.Task.CurrentStageIndex == 1 && detail.Task.Status == StatusWaitingUser {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask: %v", err)
	}
	if _, err := svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID}); err == nil {
		t.Fatalf("Next from empty agent input succeeded, want error")
	}
	detail, err = svc.GetTask(ctx, root.ID, detail.Task.ID)
	if err != nil {
		t.Fatalf("GetTask after failed next: %v", err)
	}
	if detail.Task.CurrentStageIndex != 1 {
		t.Fatalf("current stage = %d, want 1", detail.Task.CurrentStageIndex)
	}
}

func TestTaskCreateWorktreeIsTaskScoped(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})

	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Task scoped worktree",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{
		RootID:             root.ID,
		TaskTemplateID:     tmpl.ID,
		Input:              "one",
		CreateWorktree:     true,
		WorktreeBranchMode: "existing",
		WorktreeBranch:     "feature/a",
	})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if !detail.Task.CreateWorktree {
		t.Fatalf("task CreateWorktree=false, want true")
	}
	if detail.Task.WorktreeBranchMode != "existing" || detail.Task.WorktreeBranch != "feature/a" {
		t.Fatalf("task branch = %q/%q, want existing/feature/a", detail.Task.WorktreeBranchMode, detail.Task.WorktreeBranch)
	}
	disabled := false
	updated, err := svc.UpdateFirstInput(ctx, UpdateTaskInput{RootID: root.ID, TaskID: detail.Task.ID, Input: "two", CreateWorktree: &disabled})
	if err != nil {
		t.Fatalf("UpdateFirstInput: %v", err)
	}
	if updated.Task.CreateWorktree {
		t.Fatalf("updated task CreateWorktree=true, want false")
	}
}

func TestTaskTemplateEditBlockedByUnfinishedTasksExceptConcurrency(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})

	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name:           "Bug fix",
		MaxConcurrency: 1,
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	if _, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "broken"}); err != nil {
		t.Fatalf("CreateTask: %v", err)
	}

	renamed := tmpl
	renamed.Name = "Renamed"
	if _, err := svc.SaveTaskTemplate(ctx, renamed); err == nil {
		t.Fatal("SaveTaskTemplate renamed with unfinished task succeeded, want error")
	}

	concurrency := tmpl
	concurrency.MaxConcurrency = 4
	if _, err := svc.SaveTaskTemplate(ctx, concurrency); err != nil {
		t.Fatalf("SaveTaskTemplate concurrency-only returned error: %v", err)
	}

	if err := svc.DeleteTaskTemplate(ctx, tmpl.ID); err == nil {
		t.Fatal("DeleteTaskTemplate with unfinished task succeeded, want error")
	}
}

func TestTaskWorktreeNameUsesTaskNumber(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	runner := &fakeRunner{}
	svc.SetRunner(runner)

	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Worktree Number",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:               "Fix",
				Role:               RoleAgent,
				Agent:              "codex",
				Model:              "gpt-5",
				SessionReusePolicy: SessionReuseTaskMain,
				PromptTemplate:     "Fix this:\n{previous_input}",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{
		RootID:             root.ID,
		TaskTemplateID:     tmpl.ID,
		Input:              "broken save button",
		CreateWorktree:     true,
		WorktreeBranchMode: "existing",
		WorktreeBranch:     "feature/a",
	})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if detail.Task.TaskNumber != 1 {
		t.Fatalf("task number=%d, want 1", detail.Task.TaskNumber)
	}
	if _, err := svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID}); err != nil {
		t.Fatalf("Next: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		runner.mu.Lock()
		called := runner.worktreeCreateCalled
		execCount := len(runner.execs)
		runner.mu.Unlock()
		if called && execCount > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if !runner.worktreeCreateCalled {
		t.Fatalf("worktree was not created")
	}
	if runner.worktreeName != "task-1" {
		t.Fatalf("worktree name=%q, want task-1", runner.worktreeName)
	}
	if runner.worktreeBranchMode != "existing" || runner.worktreeBranch != "feature/a" {
		t.Fatalf("worktree branch=%q/%q, want existing/feature/a", runner.worktreeBranchMode, runner.worktreeBranch)
	}
	if len(runner.execs) != 1 {
		t.Fatalf("runner exec count=%d, want 1", len(runner.execs))
	}
	if runner.execs[0].RuntimeRootPath != filepath.Join(os.TempDir(), "task-1") {
		t.Fatalf("runtime root path=%q, want task worktree path", runner.execs[0].RuntimeRootPath)
	}
}

func TestTaskWorktreeCreateErrorStoredOnTask(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	runner := &fakeRunner{worktreeErr: errors.New("git worktree add failed")}
	svc.SetRunner(runner)

	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Worktree Error",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:           "Fix",
				Role:           RoleAgent,
				Agent:          "codex",
				Model:          "gpt-5",
				PromptTemplate: "Fix this:\n{previous_input}",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{
		RootID:         root.ID,
		TaskTemplateID: tmpl.ID,
		Input:          "broken save button",
		CreateWorktree: true,
	})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if _, err := svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID}); err == nil {
		t.Fatalf("Next succeeded, want worktree error")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		detail, err = svc.GetTask(ctx, root.ID, detail.Task.ID)
		if err == nil && detail.Task.AuxFlags.SessionError != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask: %v", err)
	}
	if detail.Task.Status != StatusWaitingUser {
		t.Fatalf("task status=%s, want waiting_user", detail.Task.Status)
	}
	if detail.Task.CurrentStageIndex != 0 {
		t.Fatalf("current stage=%d, want 0", detail.Task.CurrentStageIndex)
	}
	if detail.Task.AuxFlags.SessionError != "git worktree add failed" {
		t.Fatalf("session error=%q, want git worktree add failed", detail.Task.AuxFlags.SessionError)
	}
	if detail.Task.SchedulerAdmitted {
		t.Fatalf("scheduler admitted=true, want false")
	}
}

func TestUpdateCurrentInputKeepsPreviousStageInput(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})

	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Current input",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:  "Fix",
				Role:  RoleAgent,
				Agent: "codex",
				Model: "gpt-5",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "first input"})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	detail, err = svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID})
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	for _, run := range detail.StageRuns {
		if run.StageIndex == 1 && run.Input != "" {
			t.Fatalf("new current stage input=%q, want empty", run.Input)
		}
	}
	updated, err := svc.UpdateCurrentInput(ctx, UpdateTaskInput{RootID: root.ID, TaskID: detail.Task.ID, Input: "current input"})
	if err != nil {
		t.Fatalf("UpdateCurrentInput: %v", err)
	}
	firstRun := StageRun{}
	currentRun := StageRun{}
	for _, run := range updated.StageRuns {
		if run.StageIndex == 0 {
			firstRun = run
		}
		if run.StageIndex == 1 {
			currentRun = run
		}
	}
	if firstRun.Input != "first input" {
		t.Fatalf("first stage input=%q, want first input", firstRun.Input)
	}
	if currentRun.Input != "current input" {
		t.Fatalf("current stage input=%q, want current input", currentRun.Input)
	}
}

func TestCompleteFinalWaitingTask(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})

	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Final review",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "done"})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if detail.Task.Status != StatusWaitingUser {
		t.Fatalf("task status=%s, want waiting_user", detail.Task.Status)
	}
	completed, err := svc.Complete(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID, Reason: "approved"})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if completed.Task.Status != StatusSuccess {
		t.Fatalf("task status=%s, want success", completed.Task.Status)
	}
	if completed.Task.SchedulerAdmitted {
		t.Fatalf("completed task still admitted")
	}
	if completed.Task.CompletedAt == "" {
		t.Fatalf("completed_at empty")
	}
}

func TestTaskNumbersIncrement(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Numbered",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name: "Describe",
				Role: RoleUser,
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	first, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "one"})
	if err != nil {
		t.Fatalf("CreateTask first: %v", err)
	}
	second, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "two"})
	if err != nil {
		t.Fatalf("CreateTask second: %v", err)
	}
	if first.Task.TaskNumber != 1 || second.Task.TaskNumber != 2 {
		t.Fatalf("task numbers = %d/%d, want 1/2", first.Task.TaskNumber, second.Task.TaskNumber)
	}
	numbered, err := svc.ListTaskDetails(ctx, root.ID, ListTasksOptions{TaskNumber: 2})
	if err != nil {
		t.Fatalf("ListTaskDetails by task number: %v", err)
	}
	if len(numbered) != 1 || numbered[0].Task.ID != second.Task.ID {
		t.Fatalf("task number lookup = %#v, want second task", numbered)
	}
}

func TestBuildAgentPromptAppendsOnlyConfiguredContext(t *testing.T) {
	values := map[string]string{
		"previous_input":     "fix this",
		"task_initial_input": "first input",
		"task_number":        "12",
	}
	prompt := BuildAgentPrompt("Do: {previous_input}", values, TaskControlPromptContext{})
	if prompt != "Do: fix this" {
		t.Fatalf("prompt = %q", prompt)
	}
	withTaskNumber := BuildAgentPrompt("Do: {task_initial_input} #{task_number}", values, TaskControlPromptContext{})
	if withTaskNumber != "Do: first input #12" {
		t.Fatalf("task placeholders not replaced: %q", withTaskNumber)
	}
	legacy := BuildAgentPrompt("Root: {root_id}", values, TaskControlPromptContext{})
	if legacy != "Root: {root_id}" {
		t.Fatalf("legacy placeholder was replaced: %q", legacy)
	}
	withControl := BuildAgentPrompt("Do: {previous_input}", values, TaskControlPromptContext{
		RootID:            "root",
		TaskNumber:        12,
		CurrentStageIndex: "1",
		CurrentStageName:  "Agent",
		Enabled:           true,
	})
	if !containsAll(withControl, []string{"Task control context:", "task_number: 12", "mindfs root -task 12", "mindfs root -task 12 -next"}) {
		t.Fatalf("control prompt missing context: %q", withControl)
	}
}

func TestSchedulerRunsAgentStageAndStoresSessionKey(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	runner := &fakeRunner{}
	svc.SetRunner(runner)
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Agent Flow",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:               "Fix",
				Role:               RoleAgent,
				AutoAdvance:        false,
				Agent:              "codex",
				Model:              "gpt-5",
				SessionReusePolicy: SessionReuseTaskMain,
				PromptTemplate:     "Fix #{task_number}:\n{previous_input}",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "broken save button"})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	detail, err = svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID, Reason: "ready for agent"})
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		detail, err = svc.GetTask(ctx, root.ID, detail.Task.ID)
		if err == nil && detail.Task.CurrentStageIndex == 1 && detail.Task.Status == StatusWaitingUser {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask: %v", err)
	}
	if detail.Task.CurrentStageIndex != 1 || detail.Task.Status != StatusWaitingUser {
		t.Fatalf("task stage/status = %d/%s, want 1/waiting_user", detail.Task.CurrentStageIndex, detail.Task.Status)
	}
	if detail.Task.MainSessionKey == "" {
		t.Fatalf("main session key not stored")
	}
	agentRun := detail.StageRuns[len(detail.StageRuns)-1]
	if agentRun.SessionKey == "" {
		t.Fatalf("agent run session key empty: %#v", agentRun)
	}
	if !strings.Contains(agentRun.RenderedPrompt, "broken save button") {
		t.Fatalf("rendered prompt missing input: %q", agentRun.RenderedPrompt)
	}
	if !strings.Contains(agentRun.RenderedPrompt, "Fix #1") {
		t.Fatalf("rendered prompt missing task number: %q", agentRun.RenderedPrompt)
	}
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if len(runner.execs) != 1 {
		t.Fatalf("runner exec count=%d, want 1", len(runner.execs))
	}
	if runner.execs[0].Run.SessionKey != agentRun.SessionKey {
		t.Fatalf("runner session=%q, run session=%q", runner.execs[0].Run.SessionKey, agentRun.SessionKey)
	}
}

func TestAgentStageSessionErrorWaitsForUser(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	runner := &fakeRunner{runErr: errors.New("agent unavailable")}
	svc.SetRunner(runner)
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Agent Error Flow",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:               "Fix",
				Role:               RoleAgent,
				AutoAdvance:        false,
				Agent:              "codex",
				Model:              "gpt-5",
				SessionReusePolicy: SessionReuseTaskMain,
				PromptTemplate:     "Fix this:\n{previous_input}",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "broken"})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	detail, err = svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID})
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		detail, err = svc.GetTask(ctx, root.ID, detail.Task.ID)
		if err == nil && detail.Task.AuxFlags.SessionError != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask: %v", err)
	}
	if detail.Task.Status != StatusWaitingUser || !detail.Task.SchedulerAdmitted {
		t.Fatalf("task status/admitted = %s/%t, want waiting_user/true", detail.Task.Status, detail.Task.SchedulerAdmitted)
	}
	run := detail.StageRuns[len(detail.StageRuns)-1]
	if run.Status != StageStatusFail || run.FinishedAt == "" {
		t.Fatalf("stage status/finished_at = %s/%q, want fail/non-empty", run.Status, run.FinishedAt)
	}
	if detail.Task.AuxFlags.SessionError != "agent unavailable" {
		t.Fatalf("session error = %q, want agent unavailable", detail.Task.AuxFlags.SessionError)
	}
	time.Sleep(50 * time.Millisecond)
	runner.mu.Lock()
	execCount := len(runner.execs)
	runner.mu.Unlock()
	if execCount != 1 {
		t.Fatalf("agent exec count = %d, want 1", execCount)
	}
}

func TestAutoAdvanceAgentStageFailureWaitsForUserAtCurrentStage(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	svc.SetRunner(&fakeRunner{runErr: errors.New("agent unavailable")})
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Auto advance failure",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name: "Describe",
				Role: RoleUser,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:           "Implement",
				Role:           RoleAgent,
				AutoAdvance:    true,
				Agent:          "codex",
				PromptTemplate: "Implement {previous_input}",
			},
		}, {
			Position: 2,
			Snapshot: StageTemplate{
				Name: "Review",
				Role: RoleUser,
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "change"})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if _, err := svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID}); err != nil {
		t.Fatalf("Next: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		detail, err = svc.GetTask(ctx, root.ID, detail.Task.ID)
		if err == nil && detail.Task.Status == StatusWaitingUser && detail.Task.AuxFlags.SessionError != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask: %v", err)
	}
	if detail.Task.CurrentStageIndex != 1 || detail.Task.Status != StatusWaitingUser {
		t.Fatalf("task stage/status = %d/%s, want 1/waiting_user", detail.Task.CurrentStageIndex, detail.Task.Status)
	}
	if len(detail.StageRuns) != 2 {
		t.Fatalf("stage run count = %d, want 2 (no auto-advanced run)", len(detail.StageRuns))
	}
	latest := detail.StageRuns[len(detail.StageRuns)-1]
	if latest.Status != StageStatusFail {
		t.Fatalf("stage status = %s, want fail", latest.Status)
	}
}

func TestNextAdvancesFailedCurrentStageAfterUserReview(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	runner := &fakeRunner{runErr: errors.New("agent unavailable")}
	svc.SetRunner(runner)
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Running stage",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: false,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:               "Fix",
				Role:               RoleAgent,
				AutoAdvance:        false,
				Agent:              "codex",
				Model:              "gpt-5",
				SessionReusePolicy: SessionReuseTaskMain,
				PromptTemplate:     "Fix this:\n{previous_input}",
			},
		}, {
			Position: 2,
			Snapshot: StageTemplate{
				Name:           "Review",
				Role:           RoleAgent,
				Agent:          "codex",
				Model:          "gpt-5",
				PromptTemplate: "Review.",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "broken"})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	detail, err = svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID})
	if err != nil {
		t.Fatalf("Next to agent: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		detail, err = svc.GetTask(ctx, root.ID, detail.Task.ID)
		if err == nil && detail.Task.CurrentStageIndex == 1 && detail.Task.AuxFlags.SessionError != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask: %v", err)
	}
	if _, err := svc.Next(ctx, MoveInput{RootID: root.ID, TaskID: detail.Task.ID}); err != nil {
		t.Fatalf("Next from failed stage: %v", err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		detail, err = svc.GetTask(ctx, root.ID, detail.Task.ID)
		if err == nil && detail.Task.CurrentStageIndex == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask after next: %v", err)
	}
	if detail.Task.CurrentStageIndex != 2 {
		t.Fatalf("current stage = %d, want 2", detail.Task.CurrentStageIndex)
	}
}

func TestCompletingAdmittedTaskSchedulesNextQueuedTask(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	runner := &fakeRunner{}
	svc.SetRunner(runner)
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name:           "Serial Agent Flow",
		MaxConcurrency: 1,
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: true,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:               "Fix",
				Role:               RoleAgent,
				AutoAdvance:        false,
				Agent:              "codex",
				Model:              "gpt-5",
				SessionReusePolicy: SessionReuseTaskMain,
				PromptTemplate:     "Fix this:\n{previous_input}",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	first, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "first"})
	if err != nil {
		t.Fatalf("CreateTask first: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		first, err = svc.GetTask(ctx, root.ID, first.Task.ID)
		if err == nil && first.Task.CurrentStageIndex == 1 && first.Task.Status == StatusWaitingUser && first.Task.SchedulerAdmitted {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask first: %v", err)
	}
	if first.Task.Status != StatusWaitingUser || !first.Task.SchedulerAdmitted {
		t.Fatalf("first task status/admitted = %s/%t, want waiting_user/true", first.Task.Status, first.Task.SchedulerAdmitted)
	}
	second, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "second"})
	if err != nil {
		t.Fatalf("CreateTask second: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	second, err = svc.GetTask(ctx, root.ID, second.Task.ID)
	if err != nil {
		t.Fatalf("GetTask second before complete: %v", err)
	}
	if second.Task.Status != StatusQueued || second.Task.SchedulerAdmitted {
		t.Fatalf("second task status/admitted before complete = %s/%t, want queued/false", second.Task.Status, second.Task.SchedulerAdmitted)
	}
	if _, err := svc.Complete(ctx, MoveInput{RootID: root.ID, TaskID: first.Task.ID}); err != nil {
		t.Fatalf("Complete first: %v", err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		second, err = svc.GetTask(ctx, root.ID, second.Task.ID)
		if err == nil && second.Task.CurrentStageIndex == 1 && second.Task.Status == StatusWaitingUser && second.Task.SchedulerAdmitted {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask second after complete: %v", err)
	}
	if second.Task.Status != StatusWaitingUser || !second.Task.SchedulerAdmitted {
		t.Fatalf("second task status/admitted after complete = %s/%t, want waiting_user/true", second.Task.Status, second.Task.SchedulerAdmitted)
	}
}

func TestAgentStageAllowsBlankModel(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	runner := &fakeRunner{}
	svc.SetRunner(runner)
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name: "Default Model Flow",
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: true,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:               "Fix",
				Role:               RoleAgent,
				Agent:              "codex",
				SessionReusePolicy: SessionReuseTaskMain,
				PromptTemplate:     "Fix this:\n{previous_input}",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	detail, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "use defaults"})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		runner.mu.Lock()
		execCount := len(runner.execs)
		model := ""
		if execCount > 0 {
			model = runner.execs[0].Stage.Model
		}
		runner.mu.Unlock()
		if execCount > 0 {
			if model != "" {
				t.Fatalf("execution model = %q, want empty", model)
			}
			return
		}
		detail, err = svc.GetTask(ctx, root.ID, detail.Task.ID)
		if err != nil {
			t.Fatalf("GetTask: %v", err)
		}
		if detail.Task.AuxFlags.SessionError != "" {
			t.Fatalf("session error = %q", detail.Task.AuxFlags.SessionError)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("agent stage did not start")
}

func TestRunNowBypassesConcurrencySlot(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	svc.SetRunner(&fakeRunner{})
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name:           "Serial Agent Flow",
		MaxConcurrency: 1,
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: true,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:               "Fix",
				Role:               RoleAgent,
				Agent:              "codex",
				Model:              "gpt-5",
				SessionReusePolicy: SessionReuseTaskMain,
				PromptTemplate:     "Fix this:\n{previous_input}",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	first, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "first"})
	if err != nil {
		t.Fatalf("CreateTask first: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		first, err = svc.GetTask(ctx, root.ID, first.Task.ID)
		if err == nil && first.Task.Status == StatusWaitingUser && first.Task.SchedulerAdmitted {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask first: %v", err)
	}
	if first.Task.Status != StatusWaitingUser || !first.Task.SchedulerAdmitted {
		t.Fatalf("first task status/admitted = %s/%t, want waiting_user/true", first.Task.Status, first.Task.SchedulerAdmitted)
	}
	second, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "second"})
	if err != nil {
		t.Fatalf("CreateTask second: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	second, err = svc.GetTask(ctx, root.ID, second.Task.ID)
	if err != nil {
		t.Fatalf("GetTask second before run now: %v", err)
	}
	if second.Task.Status != StatusQueued || second.Task.SchedulerAdmitted {
		t.Fatalf("second task status/admitted before run now = %s/%t, want queued/false", second.Task.Status, second.Task.SchedulerAdmitted)
	}
	if _, err := svc.RunNow(ctx, MoveInput{RootID: root.ID, TaskID: second.Task.ID}); err != nil {
		t.Fatalf("RunNow second: %v", err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		second, err = svc.GetTask(ctx, root.ID, second.Task.ID)
		if err == nil && second.Task.Status == StatusWaitingUser && second.Task.SchedulerAdmitted {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask second after run now: %v", err)
	}
	if second.Task.Status != StatusWaitingUser || !second.Task.SchedulerAdmitted {
		t.Fatalf("second task status/admitted after run now = %s/%t, want waiting_user/true", second.Task.Status, second.Task.SchedulerAdmitted)
	}
}

func TestCancellingAdmittedTaskSchedulesNextQueuedTask(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "root", t.TempDir())
	store := NewTemplateStoreAt(t.TempDir())
	svc := NewService(store, testRoots{root: root})
	svc.SetRunner(&fakeRunner{})
	tmpl, err := store.SaveTaskTemplate(TaskTemplate{
		Name:           "Two Slot Agent Flow",
		MaxConcurrency: 2,
		Stages: []TaskTemplateStage{{
			Position: 0,
			Snapshot: StageTemplate{
				Name:        "Describe",
				Role:        RoleUser,
				AutoAdvance: true,
			},
		}, {
			Position: 1,
			Snapshot: StageTemplate{
				Name:               "Fix",
				Role:               RoleAgent,
				Agent:              "codex",
				Model:              "gpt-5",
				SessionReusePolicy: SessionReuseTaskMain,
				PromptTemplate:     "Fix this:\n{previous_input}",
			},
		}},
	})
	if err != nil {
		t.Fatalf("SaveTaskTemplate: %v", err)
	}
	first, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "first", CreateWorktree: true})
	if err != nil {
		t.Fatalf("CreateTask first: %v", err)
	}
	second, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "second", CreateWorktree: true})
	if err != nil {
		t.Fatalf("CreateTask second: %v", err)
	}
	third, err := svc.CreateTask(ctx, CreateTaskInput{RootID: root.ID, TaskTemplateID: tmpl.ID, Input: "third", CreateWorktree: true})
	if err != nil {
		t.Fatalf("CreateTask third: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		first, _ = svc.GetTask(ctx, root.ID, first.Task.ID)
		second, _ = svc.GetTask(ctx, root.ID, second.Task.ID)
		third, err = svc.GetTask(ctx, root.ID, third.Task.ID)
		if err == nil &&
			first.Task.Status == StatusWaitingUser && first.Task.SchedulerAdmitted &&
			second.Task.Status == StatusWaitingUser && second.Task.SchedulerAdmitted &&
			third.Task.Status == StatusQueued && !third.Task.SchedulerAdmitted {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask third before cancel: %v", err)
	}
	if first.Task.Status != StatusWaitingUser || !first.Task.SchedulerAdmitted ||
		second.Task.Status != StatusWaitingUser || !second.Task.SchedulerAdmitted ||
		third.Task.Status != StatusQueued || third.Task.SchedulerAdmitted {
		t.Fatalf("before cancel statuses: first=%s/%t second=%s/%t third=%s/%t",
			first.Task.Status, first.Task.SchedulerAdmitted,
			second.Task.Status, second.Task.SchedulerAdmitted,
			third.Task.Status, third.Task.SchedulerAdmitted)
	}
	if _, err := svc.Cancel(ctx, MoveInput{RootID: root.ID, TaskID: first.Task.ID}); err != nil {
		t.Fatalf("Cancel first: %v", err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		third, err = svc.GetTask(ctx, root.ID, third.Task.ID)
		if err == nil && third.Task.Status == StatusWaitingUser && third.Task.SchedulerAdmitted {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GetTask third after cancel: %v", err)
	}
	if third.Task.Status != StatusWaitingUser || !third.Task.SchedulerAdmitted {
		t.Fatalf("third task status/admitted after cancel = %s/%t, want waiting_user/true", third.Task.Status, third.Task.SchedulerAdmitted)
	}
}

func containsAll(value string, parts []string) bool {
	for _, part := range parts {
		if !strings.Contains(value, part) {
			return false
		}
	}
	return true
}

func TestMain(m *testing.M) {
	time.Local = time.UTC
	os.Exit(m.Run())
}
