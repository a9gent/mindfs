package claude

import (
	"strings"
	"testing"

	claudeagent "github.com/roasbeef/claude-agent-sdk-go"

	"mindfs/server/internal/agent/types"
)

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
