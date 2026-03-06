package types

import (
	"context"
	"sync"
	"sync/atomic"
)

// Session is the interface for all agent sessions.
type Session interface {
	// SendMessage sends a message to the current session.
	SendMessage(ctx context.Context, content string) error

	// CancelCurrentTurn cancels the in-flight turn, if any.
	CancelCurrentTurn() error

	// OnUpdate registers a callback for streaming updates.
	OnUpdate(onUpdate func(Event))

	// SessionID returns the current session ID.
	SessionID() string

	// Close terminates the session (not the process).
	Close() error
}

type OpenSessionInput struct {
	SessionKey string
	AgentName  string
	RootPath   string
}

// EventType defines the type of a session event.
type EventType string

const (
	EventTypeMessageChunk EventType = "message_chunk"
	EventTypeThoughtChunk EventType = "thought_chunk"
	EventTypeToolCall     EventType = "tool_call"
	EventTypeToolUpdate   EventType = "tool_update"
	EventTypeMessageDone  EventType = "message_done"
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

type ToolKind string

const (
	ToolKindRead       ToolKind = "read"
	ToolKindEdit       ToolKind = "edit"
	ToolKindDelete     ToolKind = "delete"
	ToolKindMove       ToolKind = "move"
	ToolKindSearch     ToolKind = "search"
	ToolKindExecute    ToolKind = "execute"
	ToolKindThink      ToolKind = "think"
	ToolKindFetch      ToolKind = "fetch"
	ToolKindSwitchMode ToolKind = "switch_mode"
	ToolKindOther      ToolKind = "other"
)

type ToolCallLocation struct {
	Path string `json:"path"`
	Line *int   `json:"line,omitempty"`
}

type ToolCallContentItem struct {
	Type    string  `json:"type"`
	Text    string  `json:"text,omitempty"`
	Path    string  `json:"path,omitempty"`
	OldText *string `json:"oldText,omitempty"`
	NewText string  `json:"newText,omitempty"`
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
