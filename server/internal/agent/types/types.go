package types

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// Session is the interface for all agent sessions.
type Session interface {
	// SendMessage sends a message to the current session.
	SendMessage(ctx context.Context, content string) error

	// AnswerQuestion sends a response for a pending AskUserQuestion tool call.
	AnswerQuestion(ctx context.Context, answer AskUserAnswer) error

	// CurrentModel returns the model currently used by the runtime session.
	CurrentModel() string

	// SetModel updates the model used by the current session.
	SetModel(ctx context.Context, model string) error

	// ListModels returns the models visible to the current session/runtime.
	ListModels(ctx context.Context) (ModelList, error)

	// SetMode updates the mode used by the current session.
	SetMode(ctx context.Context, mode string) error

	// ListModes returns the modes visible to the current session/runtime.
	ListModes(ctx context.Context) (ModeList, error)

	// ListCommands returns the commands visible to the current session/runtime.
	ListCommands(ctx context.Context) (CommandList, error)

	// CancelCurrentTurn cancels the in-flight turn, if any.
	CancelCurrentTurn() error

	// OnUpdate registers a callback for streaming updates.
	OnUpdate(onUpdate func(Event))

	// SessionID returns the current session ID.
	SessionID() string

	// ContextWindow returns the latest known context window usage for the session.
	ContextWindow(ctx context.Context) (ContextWindow, error)

	// Close terminates the session (not the process).
	Close() error
}

type ContextWindow struct {
	TotalTokens        int `json:"totalTokens"`
	ModelContextWindow int `json:"modelContextWindow"`
}

type OpenSessionInput struct {
	SessionKey     string
	AgentName      string
	Model          string
	Mode           string
	Effort         string
	Probe          bool
	RootPath       string
	AgentSessionID string
	AgentCtxSeq    int
}

type ExternalSessionSummary struct {
	Agent          string    `json:"agent"`
	AgentSessionID string    `json:"agent_session_id"`
	Cwd            string    `json:"cwd,omitempty"`
	FirstUserText  string    `json:"-"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type ListExternalSessionsInput struct {
	RootPath    string
	Agent       string
	BeforeTime  time.Time
	AfterTime   time.Time
	Limit       int
	FilterBound bool
}

type ListExternalSessionsResult struct {
	Items []ExternalSessionSummary `json:"items"`
}

type ImportExternalSessionInput struct {
	RootPath       string
	Agent          string
	AgentSessionID string
	AfterTimestamp time.Time
}

type ImportedExchange struct {
	Role      string
	Content   string
	Timestamp time.Time
}

type ImportedExternalSession struct {
	Agent          string
	AgentSessionID string
	Cwd            string
	Exchanges      []ImportedExchange
}

type ExternalSessionImporter interface {
	AgentName() string
	ListExternalSessions(ctx context.Context, in ListExternalSessionsInput) (ListExternalSessionsResult, error)
	ImportExternalSession(ctx context.Context, in ImportExternalSessionInput) (ImportedExternalSession, error)
}

type ModelInfo struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description,omitempty"`
	Hidden        bool   `json:"hidden,omitempty"`
	SupportEffort bool   `json:"supportEffort,omitempty"`
}

type ModelList struct {
	CurrentModelID string      `json:"current_model_id,omitempty"`
	Models         []ModelInfo `json:"models,omitempty"`
}

type ModeInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type ModeList struct {
	CurrentModeID string     `json:"current_mode_id,omitempty"`
	Modes         []ModeInfo `json:"modes,omitempty"`
}

type CommandInfo struct {
	Name         string `json:"name"`
	Description  string `json:"description,omitempty"`
	ArgumentHint string `json:"argument_hint,omitempty"`
}

type CommandList struct {
	Commands []CommandInfo `json:"commands,omitempty"`
}

// EventType defines the type of a session event.
type EventType string

const (
	EventTypeMessageChunk EventType = "message_chunk"
	EventTypeThoughtChunk EventType = "thought_chunk"
	EventTypeToolCall     EventType = "tool_call"
	EventTypeToolUpdate   EventType = "tool_update"
	EventTypeTodoUpdate   EventType = "todo_update"
	EventTypeMessageDone  EventType = "message_done"
	EventTypeRecovery     EventType = "recovery"
)

// Event is a normalized session update emitted by any agent backend.
type Event struct {
	Type      EventType
	SessionID string
	Data      any
}

type MessageChunk struct {
	Content string `json:"content"`
}

type ThoughtChunk struct {
	Content string `json:"content"`
}

type MessageDone struct {
	ContextWindow ContextWindow `json:"contextWindow"`
}

type RecoveryStatus struct {
	Message string `json:"message"`
}

type TodoItem struct {
	Content    string `json:"content"`
	ActiveForm string `json:"activeForm,omitempty"`
	Status     string `json:"status"`
}

type TodoUpdate struct {
	Items []TodoItem `json:"items"`
}

type AskUserQuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type AskUserQuestionItem struct {
	Question    string                  `json:"question"`
	Header      string                  `json:"header,omitempty"`
	Options     []AskUserQuestionOption `json:"options,omitempty"`
	MultiSelect bool                    `json:"multiSelect,omitempty"`
}

type AskUserAnswer struct {
	ToolUseID string            `json:"toolUseId"`
	Answers   map[string]string `json:"answers"`
}

type ToolKind string

const (
	ToolKindRead       ToolKind = "read"
	ToolKindEdit       ToolKind = "edit"
	ToolKindDelete     ToolKind = "delete"
	ToolKindMove       ToolKind = "move"
	ToolKindSearch     ToolKind = "search"
	ToolKindWebSearch  ToolKind = "web_search"
	ToolKindExecute    ToolKind = "execute"
	ToolKindThink      ToolKind = "think"
	ToolKindFetch      ToolKind = "fetch"
	ToolKindTask       ToolKind = "task"
	ToolKindAskUser    ToolKind = "ask_user"
	ToolKindTodo       ToolKind = "todo"
	ToolKindSwitchMode ToolKind = "switch_mode"
	ToolKindOther      ToolKind = "other"
)

type ToolCallLocation struct {
	Path string `json:"path"`
	Line *int   `json:"line,omitempty"`
}

type ToolCallContentItem struct {
	Type       string  `json:"type"`
	Text       string  `json:"text,omitempty"`
	Path       string  `json:"path,omitempty"`
	ChangeKind string  `json:"changeKind,omitempty"`
	OldText    *string `json:"oldText,omitempty"`
	NewText    string  `json:"newText,omitempty"`
}

type ToolCall struct {
	CallID    string                `json:"callId"`
	Title     string                `json:"title,omitempty"`
	Status    string                `json:"status"`
	Kind      ToolKind              `json:"kind"`
	Content   []ToolCallContentItem `json:"content,omitempty"`
	Locations []ToolCallLocation    `json:"locations,omitempty"`
	RawType   string                `json:"rawType,omitempty"`
	Meta      map[string]any        `json:"meta,omitempty"`
}

func (tc ToolCall) IsWriteOperation() bool {
	switch tc.Kind {
	case ToolKindEdit, ToolKindDelete, ToolKindMove:
		return true
	default:
		return false
	}
}

func (tc ToolCall) GetAffectedPaths() []string {
	paths := make([]string, 0, len(tc.Locations))
	for _, loc := range tc.Locations {
		if loc.Path != "" {
			paths = append(paths, loc.Path)
		}
	}
	return paths
}

type TurnCanceler struct {
	mu     sync.RWMutex
	cancel context.CancelFunc
	turnID uint64
}

func (t *TurnCanceler) Begin(parent context.Context) (context.Context, uint64) {
	turnCtx, cancel := context.WithCancel(parent)
	turnID := atomic.AddUint64(&t.turnID, 1)

	t.mu.Lock()
	t.cancel = cancel
	t.turnID = turnID
	t.mu.Unlock()

	return turnCtx, turnID
}

func (t *TurnCanceler) Cancel() {
	t.mu.RLock()
	cancel := t.cancel
	t.mu.RUnlock()
	if cancel != nil {
		cancel()
	}
}

func (t *TurnCanceler) End(turnID uint64) {
	t.mu.Lock()
	if t.turnID == turnID {
		t.cancel = nil
	}
	t.mu.Unlock()
}
