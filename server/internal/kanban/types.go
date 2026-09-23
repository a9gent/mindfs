package kanban

import (
	"context"
	"time"
)

const (
	RoleUser  = "user"
	RoleAgent = "agent"

	StatusPending     = "pending"
	StatusQueued      = "queued"
	StatusRunning     = "running"
	StatusWaitingUser = "waiting_user"
	StatusPaused      = "paused"
	StatusSuccess     = "success"
	StatusFail        = "fail"
	StatusCancelled   = "cancelled"

	StageStatusPending     = "pending"
	StageStatusRunning     = "running"
	StageStatusWaitingUser = "waiting_user"
	StageStatusSuccess     = "success"
	StageStatusFail        = "fail"
	StageStatusCancelled   = "cancelled"
	StageStatusApproved    = "approved"
	StageStatusRejected    = "rejected"

	SessionReuseTaskMain  = "task_main"
	SessionReuseSameStage = "same_stage"
	SessionReuseAlwaysNew = "always_new"
)

type StageTemplate struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	Role               string    `json:"role"`
	AutoAdvance        bool      `json:"auto_advance"`
	Agent              string    `json:"agent,omitempty"`
	Model              string    `json:"model,omitempty"`
	Mode               string    `json:"mode,omitempty"`
	Effort             string    `json:"effort,omitempty"`
	FastService        string    `json:"fast_service,omitempty"`
	PlanMode           bool      `json:"plan_mode,omitempty"`
	SessionReusePolicy string    `json:"session_reuse_policy,omitempty"`
	PromptTemplate     string    `json:"prompt_template,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

type TaskTemplateStage struct {
	ID              string        `json:"id"`
	StageTemplateID string        `json:"stage_template_id,omitempty"`
	Position        int           `json:"position"`
	Snapshot        StageTemplate `json:"snapshot"`
}

type TaskTemplate struct {
	ID             string              `json:"id"`
	Name           string              `json:"name"`
	Description    string              `json:"description,omitempty"`
	MaxConcurrency int                 `json:"max_concurrency"`
	Stages         []TaskTemplateStage `json:"stages"`
	CreatedAt      time.Time           `json:"created_at"`
	UpdatedAt      time.Time           `json:"updated_at"`
}

type Task struct {
	GroupID     string  `json:"group_id,omitempty"`
	Agent       string  `json:"agent,omitempty"`
	Model       *string `json:"model,omitempty"`
	Published   bool    `json:"published"`
	BlockReason string  `json:"block_reason,omitempty"`

	DependsOn []string `json:"depends_on,omitempty"`

	ID                 string       `json:"id"`
	TaskNumber         int          `json:"task_number"`
	RootID             string       `json:"root_id"`
	TaskTemplateID     string       `json:"task_template_id"`
	TaskTemplateName   string       `json:"task_template_name"`
	CreateWorktree     bool         `json:"create_worktree"`
	WorktreeBranchMode string       `json:"worktree_branch_mode,omitempty"`
	WorktreeBranch     string       `json:"worktree_branch,omitempty"`
	CurrentStageIndex  int          `json:"current_stage_index"`
	Status             string       `json:"status"`
	SchedulerAdmitted  bool         `json:"scheduler_admitted"`
	MainSessionKey     string       `json:"main_session_key,omitempty"`
	WorktreeRootID     string       `json:"worktree_root_id,omitempty"`
	WorktreePath       string       `json:"worktree_path,omitempty"`
	Labels             []string     `json:"labels"`
	CreatedAt          time.Time    `json:"created_at"`
	UpdatedAt          time.Time    `json:"updated_at"`
	CompletedAt        string       `json:"completed_at,omitempty"`
	CurrentStageName   string       `json:"current_stage_name,omitempty"`
	CurrentStageStatus string       `json:"current_stage_status,omitempty"`
	AuxFlags           TaskAuxFlags `json:"aux_flags"`
}

type TaskAuxFlags struct {
	AskUserWaiting bool   `json:"ask_user_waiting"`
	HasPlan        bool   `json:"has_plan"`
	HasTodos       bool   `json:"has_todos"`
	HasTask        bool   `json:"has_task"`
	SessionError   string `json:"session_error,omitempty"`
}

type TaskAuxFlagsPatch struct {
	AskUserWaiting *bool
	HasPlan        *bool
	HasTodos       *bool
	HasTask        *bool
	SessionError   *string
}

type StageRun struct {
	Trigger string `json:"trigger,omitempty"`
	Result  string `json:"result,omitempty"`

	ID             string    `json:"id"`
	TaskID         string    `json:"task_id"`
	StageIndex     int       `json:"stage_index"`
	StageName      string    `json:"stage_name"`
	Role           string    `json:"role"`
	Status         string    `json:"status"`
	SessionKey     string    `json:"session_key,omitempty"`
	Input          string    `json:"input,omitempty"`
	RenderedPrompt string    `json:"rendered_prompt,omitempty"`
	StartedAt      string    `json:"started_at,omitempty"`
	FinishedAt     string    `json:"finished_at,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type TaskEvent struct {
	ReceiverTaskID string `json:"receiver_task_id,omitempty"`
	HandledAt      string `json:"handled_at,omitempty"`

	ID         string    `json:"id"`
	TaskID     string    `json:"task_id"`
	StageRunID string    `json:"stage_run_id,omitempty"`
	Type       string    `json:"type"`
	Payload    string    `json:"payload_json,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

type TaskDetail struct {
	Task      Task        `json:"task"`
	StageRuns []StageRun  `json:"stage_runs"`
	Events    []TaskEvent `json:"events"`
}

type WorktreeInfo struct {
	RootID string
	Path   string
}

type AgentStageExecution struct {
	RootID          string
	RuntimeRootPath string
	Task            Task
	Stage           StageTemplate
	Run             StageRun
	Prompt          string
}

type Runner interface {
	CreateTaskWorktree(ctx context.Context, rootID, name, branchMode, branch string) (WorktreeInfo, error)
	EnsureAgentSession(ctx context.Context, exec AgentStageExecution) (string, error)
	RunAgentStage(ctx context.Context, exec AgentStageExecution) error
	TaskUpdated(rootID string, detail TaskDetail)
}
