package claude

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
)

func TestExtractClaudeUserPreviewUsesLastMeaningfulContentBlock(t *testing.T) {
	raw := []any{
		map[string]any{"type": "text", "text": "<local-command-caveat>internal</local-command-caveat>"},
		map[string]any{"type": "text", "text": "actual request"},
	}
	if got := extractClaudeUserPreview(raw); got != "actual request" {
		t.Fatalf("preview = %q, want actual request", got)
	}
}

func TestExtractClaudeImportedUserTextDropsOnlyInjectedBlocks(t *testing.T) {
	raw := []any{
		map[string]any{"type": "text", "text": "<local-command-caveat>internal</local-command-caveat>"},
		map[string]any{"type": "text", "text": "first actual block"},
		map[string]any{"type": "text", "text": "second actual block"},
	}
	want := "first actual block\n\nsecond actual block"
	if got := extractClaudeImportedUserText(raw); got != want {
		t.Fatalf("imported text = %q, want %q", got, want)
	}
}

func TestReadClaudeImportedExchangesIgnoresUnsupportedToolCall(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	content := `{"type":"user","uuid":"u1","timestamp":"2026-07-28T01:00:00Z","message":{"content":[{"type":"text","text":"inspect README"}]}}
{"type":"assistant","uuid":"a1","timestamp":"2026-07-28T01:00:01Z","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"README.md"}}]}}
{"type":"user","uuid":"u2","timestamp":"2026-07-28T01:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"README contents"}]}}
{"type":"assistant","uuid":"a2","timestamp":"2026-07-28T01:00:03Z","message":{"content":[{"type":"text","text":"done"}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	items, err := readClaudeImportedExchanges(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("len(items) = %d, want 2: %#v", len(items), items)
	}
	if items[0].Role != "user" || items[0].Content != "inspect README" {
		t.Fatalf("user exchange = %#v", items[0])
	}
	if items[1].Role != "agent" || items[1].Content != "done" || len(items[1].Aux) != 0 {
		t.Fatalf("assistant exchange = %#v, want text without aux", items[1])
	}
}

func TestReadClaudeImportedExchangesMarksFailedToolResult(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	content := `{"type":"user","uuid":"u1","timestamp":"2026-07-28T01:00:00Z","message":{"content":"run"}}
{"type":"assistant","uuid":"a1","timestamp":"2026-07-28T01:00:01Z","message":{"content":[{"type":"text","text":"running"},{"type":"tool_use","id":"tool-2","name":"Bash","input":{"command":"false"}}]}}
{"type":"user","uuid":"u2","timestamp":"2026-07-28T01:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"tool-2","is_error":true,"content":"exit status 1"}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	items, err := readClaudeImportedExchanges(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || len(items[1].Aux) != 1 || items[1].Aux[0].ToolCall == nil {
		t.Fatalf("items = %#v", items)
	}
	toolCall := items[1].Aux[0].ToolCall
	if toolCall.Status != "failed" || toolCall.Kind != agenttypes.ToolKindExecute {
		t.Fatalf("failed tool call = %#v", toolCall)
	}
	if items[1].Aux[0].Line != 1 {
		t.Fatalf("tool call line = %d, want 1", items[1].Aux[0].Line)
	}
}

func TestReadClaudeImportedExchangesIncludesPlanToolCall(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	content := `{"type":"assistant","timestamp":"2026-07-28T01:00:01Z","message":{"content":[{"type":"tool_use","id":"plan-1","name":"EnterPlanMode","input":{}}]}}
{"type":"user","timestamp":"2026-07-28T01:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"plan-1","content":"entered plan mode"}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	items, err := readClaudeImportedExchanges(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || len(items[0].Aux) != 1 || items[0].Aux[0].ToolCall == nil {
		t.Fatalf("items = %#v", items)
	}
	toolCall := items[0].Aux[0].ToolCall
	if toolCall.Kind != agenttypes.ToolKindThink || toolCall.Status != "complete" {
		t.Fatalf("plan tool call = %#v", toolCall)
	}
}

func TestReadClaudeImportedExchangesIncludesAskUserToolCall(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	content := `{"type":"assistant","timestamp":"2026-07-28T01:00:01Z","message":{"content":[{"type":"tool_use","id":"ask-1","name":"AskUserQuestion","input":{"questions":[{"question":"Continue?","options":[{"label":"Yes"}]}]}}]}}
{"type":"user","timestamp":"2026-07-28T01:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"ask-1","content":"Yes"}]},"toolUseResult":{"questions":[{"question":"Continue?"}],"answers":{"Continue?":"Yes"}}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	items, err := readClaudeImportedExchanges(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || len(items[0].Aux) != 1 || items[0].Aux[0].ToolCall == nil {
		t.Fatalf("items = %#v", items)
	}
	toolCall := items[0].Aux[0].ToolCall
	if toolCall.Kind != agenttypes.ToolKindAskUser || toolCall.Status != "complete" {
		t.Fatalf("ask-user tool call = %#v", toolCall)
	}
	if toolCall.Meta["questionCount"] != 1 {
		t.Fatalf("ask-user meta = %#v, want question count", toolCall.Meta)
	}
	answers, _ := toolCall.Meta["answers"].(map[string]string)
	if answers["q_0"] != "Yes" {
		t.Fatalf("ask-user answers = %#v, want q_0=Yes", toolCall.Meta["answers"])
	}
}

func TestReadClaudeImportedSubagentsLinksAgentToolCall(t *testing.T) {
	dir := t.TempDir()
	parentPath := filepath.Join(dir, "parent.jsonl")
	parent := `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-agent-1","name":"Agent","input":{"description":"Inspect importer","subagent_type":"Explore","model":"sonnet"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-agent-1","content":"done"}]},"toolUseResult":{"agentId":"child-1","agentType":"Explore","resolvedModel":"claude-sonnet"}}
`
	if err := os.WriteFile(parentPath, []byte(parent), 0o600); err != nil {
		t.Fatal(err)
	}
	subagentDir := filepath.Join(dir, "parent", "subagents")
	if err := os.MkdirAll(subagentDir, 0o700); err != nil {
		t.Fatal(err)
	}
	child := `{"type":"user","agentId":"child-1","timestamp":"2026-07-28T01:00:00Z","message":{"content":"inspect"}}
{"type":"assistant","agentId":"child-1","timestamp":"2026-07-28T01:00:01Z","message":{"content":[{"type":"text","text":"found it"}]}}
`
	if err := os.WriteFile(filepath.Join(subagentDir, "agent-child-1.jsonl"), []byte(child), 0o600); err != nil {
		t.Fatal(err)
	}
	items, err := readClaudeImportedSubagents(parentPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("len(subagents) = %d, want 1: %#v", len(items), items)
	}
	item := items[0]
	if item.AgentSessionID != "claude-subagent:child-1" ||
		item.ParentToolCallID != "tool-agent-1" ||
		item.Title != "Inspect importer" ||
		item.Model != "sonnet" {
		t.Fatalf("subagent = %#v", item)
	}
	if len(item.Exchanges) != 2 {
		t.Fatalf("len(exchanges) = %d, want 2", len(item.Exchanges))
	}
}

func TestClaudeProjectDirNameMatchesClaudeCodeOnDiskEncoding(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		{"ascii path keeps letters and digits", "/Users/Ye/Databases/L000", "-Users-Ye-Databases-L000"},
		{"cjk and space chars become dashes", "/Users/Ye/HOBBIES/260817Claude Code远程访问第三方方案", "-Users-Ye-HOBBIES-260817Claude-Code---------"},
		{"dot becomes dash", "/Users/Ye/.claude", "-Users-Ye--claude"},
		{"underscore becomes dash", "/a_b/c", "-a-b-c"},
		{"emoji becomes two dashes", "/Users/test/😀", "-Users-test---"},
		{"supplementary cjk becomes two dashes", "/Users/test/𠀀", "-Users-test---"},
		{"tailing slash stripped", "/Users/Ye/L000/", "-Users-Ye-L000"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := claudeProjectDirName(tt.path); got != tt.want {
				t.Fatalf("claudeProjectDirName(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

func TestSanitizeClaudeProjectPathTruncatesAndHashesLongPaths(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		{"ascii", strings.Repeat("a", 201), strings.Repeat("a", 200) + "-rkvsv5"},
		{"utf16 hash", strings.Repeat("a", 199) + "😀", strings.Repeat("a", 199) + "--rlxqg4"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeClaudeProjectPath(tt.path); got != tt.want {
				t.Fatalf("sanitizeClaudeProjectPath(long path) = %q, want %q", got, tt.want)
			}
		})
	}
}
