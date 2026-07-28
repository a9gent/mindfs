package claude

import (
	"encoding/json"
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

func TestClaudePartialInputJSONDeltaIsKnownNonDisplayEvent(t *testing.T) {
	raw := json.RawMessage(`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"具"}}`)

	textDelta, thinkingDelta := extractDeltas(raw)
	if textDelta != "" || thinkingDelta != "" {
		t.Fatalf("extractDeltas = %q, %q; want no display deltas", textDelta, thinkingDelta)
	}
	if !isKnownNonDisplayPartialEvent(raw) {
		t.Fatalf("input_json_delta should be recognized as non-display partial event")
	}
}

func TestClaudeThinkingTokensMessageUpdatesSessionIDOnly(t *testing.T) {
	events := make([]types.Event, 0, 1)
	s := &session{onUpdate: func(event types.Event) {
		events = append(events, event)
	}}

	msg := claudeagent.ThinkingTokensMessage{
		Type:                 "system",
		Subtype:              "thinking_tokens",
		EstimatedTokens:      43,
		EstimatedTokensDelta: 2,
		SessionID:            "claude-session",
	}
	s.updateSessionID(msg)

	if s.SessionID() != "claude-session" {
		t.Fatalf("session id = %q, want claude-session", s.SessionID())
	}
	if len(events) != 0 {
		t.Fatalf("events = %#v, want none", events)
	}
}

func TestClaudeTaskNotificationEmitsTerminalTaskUpdate(t *testing.T) {
	events := make([]types.Event, 0, 1)
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) {
		events = append(events, event)
	}}
	s.trackTaskInfo("task-1", claudeTaskInfo{ToolUseID: "tool-1", TaskType: "local_agent"})

	s.handleTaskNotificationMessage(claudeagent.TaskNotificationMessage{
		Subtype:    "task_notification",
		TaskID:     "task-1",
		ToolUseID:  "tool-1",
		Status:     claudeagent.TaskNotificationStatusCompleted,
		OutputFile: "/tmp/claude-task-output.md",
		Summary:    "subagent finished",
	})

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one terminal update", events)
	}
	if events[0].Type != types.EventTypeToolUpdate {
		t.Fatalf("event type = %q, want tool update", events[0].Type)
	}
	toolCall, ok := events[0].Data.(types.ToolCall)
	if !ok {
		t.Fatalf("event data = %T, want ToolCall", events[0].Data)
	}
	if toolCall.CallID != "tool-1" || toolCall.Status != "complete" {
		t.Fatalf("toolCall = %#v, want terminal update for original tool call", toolCall)
	}
	if toolCall.Meta["subtype"] != "task_notification" || toolCall.Meta["summary"] != "subagent finished" {
		t.Fatalf("meta = %#v, want notification metadata", toolCall.Meta)
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

func TestClaudeTaskUpdatedUsesOriginalToolUseIDAndDescription(t *testing.T) {
	var got types.Event
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) {
		got = event
	}}

	s.handleTaskStartedMessage(claudeagent.TaskStartedMessage{
		TaskID:       "aab5b6559d82ef106",
		ToolUseID:    "call-task-1",
		TaskType:     "local_agent",
		Description:  "Review changed files",
		SubagentType: "general-purpose",
	})
	s.handleTaskUpdatedMessage(claudeagent.TaskUpdatedMessage{
		TaskID:  "aab5b6559d82ef106",
		Subtype: "task_updated",
		Patch:   claudeagent.TaskUpdatePatch{Status: claudeagent.TaskRunStatusCompleted},
	})

	if got.Type != types.EventTypeToolUpdate {
		t.Fatalf("event type = %q, want tool update", got.Type)
	}
	toolCall, ok := got.Data.(types.ToolCall)
	if !ok {
		t.Fatalf("event data = %T, want ToolCall", got.Data)
	}
	if toolCall.CallID != "call-task-1" {
		t.Fatalf("callID = %q, want original tool use id", toolCall.CallID)
	}
	if toolCall.Title != "Review changed files" {
		t.Fatalf("title = %q, want original task description", toolCall.Title)
	}
	if toolCall.Status != "complete" {
		t.Fatalf("status = %q, want complete", toolCall.Status)
	}
	if toolCall.Meta["taskId"] != "aab5b6559d82ef106" || toolCall.Meta["parentToolUseId"] != "call-task-1" {
		t.Fatalf("meta = %#v, want task id and parent tool use id", toolCall.Meta)
	}
}

func TestClaudeTaskCreateAndUpdateToolUseMapToTaskKind(t *testing.T) {
	for _, name := range []string{"TaskCreate", "TaskUpdate", "TaskList", "TaskGet"} {
		if got := mapToolKind(name); got != types.ToolKindTask {
			t.Fatalf("mapToolKind(%q) = %q, want task", name, got)
		}
	}
}

func TestClaudePlanToolsMapToThinkKind(t *testing.T) {
	for _, name := range []string{"Think", "UpdatePlan", "update_plan", "EnterPlanMode", "ExitPlanMode"} {
		if got := mapToolKind(name); got != types.ToolKindThink {
			t.Fatalf("mapToolKind(%q) = %q, want think", name, got)
		}
	}
}

func TestClaudeTaskCreateResultUsesReturnedTaskID(t *testing.T) {
	parentID := "call-create-1"
	s := &session{}
	create := newRunningToolCall(
		parentID,
		"TaskCreate",
		"tool_use",
		json.RawMessage(`{"subject":"检查 git 状态","description":"检查当前 git 修改状态","activeForm":"检查 git 状态"}`),
	)
	create.Meta = mergeToolCallMeta(create.Meta, map[string]any{
		"taskTool":  "TaskCreate",
		"toolUseId": parentID,
	})
	s.trackPendingToolCall(create)

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ParentToolUseID: &parentID,
		ToolUseResult:   map[string]any{"task": map[string]any{"id": "7", "subject": "检查 git 状态"}},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if update.CallID != "claude-task-list:7" || update.Status != "running" {
		t.Fatalf("update = %#v, want returned task id and running status", update)
	}
	if update.Title != "检查 git 状态" || update.Meta["taskId"] != "7" || update.Meta["taskTool"] != "TaskCreate" {
		t.Fatalf("update = %#v, want create title and real task meta", update)
	}
}

func TestClaudeTaskUpdateResultPreservesTaskStatus(t *testing.T) {
	parentID := "call-update-1"
	s := &session{}
	updateBase := newRunningToolCall(
		parentID,
		"TaskUpdate",
		"tool_use",
		json.RawMessage(`{"taskId":"7","status":"completed"}`),
	)
	updateBase.Meta = mergeToolCallMeta(updateBase.Meta, map[string]any{
		"taskTool":  "TaskUpdate",
		"toolUseId": parentID,
	})
	s.trackPendingToolCall(updateBase)

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ParentToolUseID: &parentID,
		ToolUseResult: map[string]any{
			"success":       true,
			"taskId":        "7",
			"statusChange":  map[string]any{"from": "pending", "to": "completed"},
			"updatedFields": []any{"status"},
		},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if update.CallID != "claude-task-list:7" || update.Status != "complete" {
		t.Fatalf("update = %#v, want real complete task update", update)
	}
	if update.Title != "" || len(update.Content) != 0 {
		t.Fatalf("update = %#v, want status-only task update", update)
	}
	if update.Meta["taskId"] != "7" || update.Meta["taskStatus"] != "complete" {
		t.Fatalf("meta = %#v, want real task id and status", update.Meta)
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
