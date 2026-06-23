package claude

import (
	"strings"
	"testing"

	claudeagent "github.com/roasbeef/claude-agent-sdk-go"

	"mindfs/server/internal/agent/types"
)

func TestClaudeCompactBoundaryEmitsCompactNotice(t *testing.T) {
	var got types.Event
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) { got = event }}

	s.handleCompactBoundaryMessage(claudeagent.CompactBoundaryMessage{
		UUID:      "compact-1",
		SessionID: "claude-session",
		CompactMetadata: claudeagent.CompactMetadata{
			Trigger:   "auto",
			PreTokens: 1200,
		},
	})

	if got.Type != types.EventTypeCompact {
		t.Fatalf("event type = %q, want compact", got.Type)
	}
	notice, ok := got.Data.(types.CompactNotice)
	if !ok {
		t.Fatalf("event data = %T, want CompactNotice", got.Data)
	}
	if notice.ID != "compact-1" || notice.Status != "auto" || !strings.Contains(notice.Summary, "1200") {
		t.Fatalf("notice = %#v", notice)
	}
}

func TestClaudeAuthStatusEmitsToolUpdate(t *testing.T) {
	var got types.Event
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) { got = event }}

	s.handleAuthStatusMessage(claudeagent.AuthStatusMessage{
		UUID:             "auth-1",
		IsAuthenticating: true,
		Output:           []string{"open browser"},
	})

	if got.Type != types.EventTypeToolUpdate {
		t.Fatalf("event type = %q, want tool update", got.Type)
	}
	toolCall, ok := got.Data.(types.ToolCall)
	if !ok {
		t.Fatalf("event data = %T, want ToolCall", got.Data)
	}
	if toolCall.RawType != "auth_status" || toolCall.Status != "running" {
		t.Fatalf("toolCall = %#v", toolCall)
	}
}

func TestClaudePlainStreamEventFallsBackToMessageChunk(t *testing.T) {
	var got types.Event
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) { got = event }}

	s.handleStreamEvent(claudeagent.StreamEvent{Type: "stream_event", Event: "delta", Delta: "hello"})

	if got.Type != types.EventTypeMessageChunk {
		t.Fatalf("event type = %q, want message chunk", got.Type)
	}
	chunk, ok := got.Data.(types.MessageChunk)
	if !ok || chunk.Content != "hello" {
		t.Fatalf("chunk = %#v", got.Data)
	}
}

func TestClaudeTaskNotificationIsIgnored(t *testing.T) {
	events := make([]types.Event, 0, 1)
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) {
		events = append(events, event)
	}}

	s.handleTaskNotificationMessage(claudeagent.TaskNotificationMessage{
		TaskID:    "task-1",
		ToolUseID: "tool-1",
		Status:    claudeagent.TaskNotificationStatusCompleted,
		Summary:   "subagent finished",
	})

	if len(events) != 0 {
		t.Fatalf("events = %#v, want none", events)
	}
}

func TestClaudeLocalBashTaskLifecycleIsIgnored(t *testing.T) {
	events := make([]types.Event, 0, 3)
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) {
		events = append(events, event)
	}}

	s.handleTaskStartedMessage(claudeagent.TaskStartedMessage{
		TaskID:      "task-1",
		ToolUseID:   "tool-1",
		TaskType:    "local_bash",
		Description: "Run shell command",
	})
	s.handleTaskProgressMessage(claudeagent.TaskProgressMessage{
		TaskID:       "task-1",
		ToolUseID:    "tool-1",
		Description:  "Run shell command",
		LastToolName: "Bash",
	})
	s.handleTaskUpdatedMessage(claudeagent.TaskUpdatedMessage{
		TaskID: "task-1",
		Patch:  claudeagent.TaskUpdatePatch{Status: claudeagent.TaskRunStatusCompleted},
	})

	if len(events) != 0 {
		t.Fatalf("events = %#v, want none", events)
	}
}

func TestClaudeLocalAgentTaskProgressEmitsParentTaskUpdate(t *testing.T) {
	events := make([]types.Event, 0, 2)
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) {
		events = append(events, event)
	}}

	s.handleTaskStartedMessage(claudeagent.TaskStartedMessage{
		TaskID:       "agent-1",
		ToolUseID:    "tool-1",
		TaskType:     "local_agent",
		Description:  "Print hi",
		SubagentType: "general-purpose",
		Prompt:       "prompt body",
	})
	s.handleTaskProgressMessage(claudeagent.TaskProgressMessage{
		TaskID:       "agent-1",
		ToolUseID:    "tool-1",
		Description:  "Print hi",
		SubagentType: "general-purpose",
	})

	if len(events) != 2 {
		t.Fatalf("events = %#v, want start and progress", events)
	}
	if events[0].Type != types.EventTypeToolCall || events[1].Type != types.EventTypeToolUpdate {
		t.Fatalf("event types = %q, %q", events[0].Type, events[1].Type)
	}
}

func TestClaudeTaskProgressDoesNotOverridePendingToolTitle(t *testing.T) {
	var got types.Event
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) {
		got = event
	}}
	s.trackPendingToolCall(types.ToolCall{
		CallID: "tool-1",
		Title:  "Print hi 5 times every 10s",
		Status: "running",
		Kind:   types.ToolKindTask,
	})

	s.handleTaskProgressMessage(claudeagent.TaskProgressMessage{
		TaskID:       "agent-1",
		ToolUseID:    "tool-1",
		Description:  "Acknowledging the user's instructions",
		SubagentType: "general-purpose",
	})

	if got.Type != types.EventTypeToolUpdate {
		t.Fatalf("event type = %q, want tool update", got.Type)
	}
	toolCall, ok := got.Data.(types.ToolCall)
	if !ok {
		t.Fatalf("event data = %T, want ToolCall", got.Data)
	}
	if toolCall.Title != "" {
		t.Fatalf("progress title = %q, want empty to preserve original title", toolCall.Title)
	}
	if toolCall.Meta["progress"] != "Acknowledging the user's instructions" {
		t.Fatalf("progress meta = %#v", toolCall.Meta)
	}
}

func TestSummarizeGenericToolResultContentBlocks(t *testing.T) {
	raw := map[string]any{
		"content": []any{
			map[string]any{"type": "text", "text": "first"},
			map[string]any{"type": "text", "text": "second"},
		},
	}

	got := summarizeGenericToolResult(raw)
	if got != "first\nsecond" {
		t.Fatalf("summarizeGenericToolResult = %q, want content block text", got)
	}
}

func TestSummarizeGenericToolResultJSONString(t *testing.T) {
	got := summarizeGenericToolResult(`{"output":"git diff output"}`)
	if got != "git diff output" {
		t.Fatalf("summarizeGenericToolResult = %q, want decoded output", got)
	}
}

func TestToolResultUpdateFallsBackToOnlyPendingTool(t *testing.T) {
	s := &session{
		pendingToolCalls: map[string]types.ToolCall{
			"call-1": {
				CallID: "call-1",
				Status: "running",
				Kind:   types.ToolKindExecute,
			},
		},
	}

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ToolUseResult: map[string]any{"content": "command output"},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if update.Status != "complete" {
		t.Fatalf("status = %q, want complete", update.Status)
	}
	if len(update.Content) != 1 || !strings.Contains(update.Content[0].Text, "command output") {
		t.Fatalf("content = %#v, want command output", update.Content)
	}
}
