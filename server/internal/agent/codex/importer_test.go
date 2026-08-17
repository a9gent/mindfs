package codex

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
)

func TestInspectCodexSessionFileSkipsInjectedUserPromptBlocks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	content := `{"timestamp":"2026-07-28T01:00:00Z","type":"session_meta","payload":{"id":"session-1","cwd":"/project"}}
{"timestamp":"2026-07-28T01:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<recommended_plugins>internal</recommended_plugins>"},{"type":"input_text","text":"# AGENTS.md instructions\n<INSTRUCTIONS>internal</INSTRUCTIONS>"},{"type":"input_text","text":"<environment_context>internal</environment_context>"}]}}
{"timestamp":"2026-07-28T01:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"actual request"}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	item, ok, err := inspectCodexSessionFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("inspectCodexSessionFile returned not found")
	}
	if item.FirstUserText != "actual request" {
		t.Fatalf("FirstUserText = %q, want actual request", item.FirstUserText)
	}
}

func TestExternalSessionFileCursorDetectsUnchangedAndChangedFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cursor, unchanged, err := externalSessionFileCursor(path, agenttypes.ExternalSessionCursor{})
	if err != nil || unchanged {
		t.Fatalf("first cursor: unchanged=%v err=%v", unchanged, err)
	}
	if _, unchanged, err = externalSessionFileCursor(path, cursor); err != nil || !unchanged {
		t.Fatalf("second cursor: unchanged=%v err=%v", unchanged, err)
	}
	if err := os.WriteFile(path, []byte("one\ntwo\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, unchanged, err = externalSessionFileCursor(path, cursor); err != nil || unchanged {
		t.Fatalf("changed cursor: unchanged=%v err=%v", unchanged, err)
	}
}

func TestExtractCodexImportedUserTextDropsOnlyInjectedBlocks(t *testing.T) {
	raw := []any{
		map[string]any{"type": "input_text", "text": "<recommended_plugins>internal</recommended_plugins>"},
		map[string]any{"type": "input_text", "text": "# AGENTS.md instructions\n<INSTRUCTIONS>internal</INSTRUCTIONS>"},
		map[string]any{"type": "input_text", "text": "first actual block"},
		map[string]any{"type": "input_text", "text": "<environment_context>internal</environment_context>"},
		map[string]any{"type": "input_text", "text": "second actual block"},
	}
	want := "first actual block\n\nsecond actual block"
	if got := extractCodexImportedUserText(raw); got != want {
		t.Fatalf("imported text = %q, want %q", got, want)
	}
}

func TestExtractCodexImportedUserTextPreservesMixedBlock(t *testing.T) {
	raw := []any{map[string]any{
		"type": "input_text",
		"text": "<environment_context>internal</environment_context>\nactual request",
	}}
	want := "<environment_context>internal</environment_context>\nactual request"
	if got := extractCodexImportedUserText(raw); got != want {
		t.Fatalf("imported text = %q, want %q", got, want)
	}
}

func TestReadCodexImportedExchangeLocatorsAppliesRollbackBeforeTimestampFilter(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout.jsonl")
	content := `{"timestamp":"2026-06-22T01:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"u1"}]}}
{"timestamp":"2026-06-22T01:00:01Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1"}]}}
{"timestamp":"2026-06-22T01:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"u2"}]}}
{"timestamp":"2026-06-22T01:00:03Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2"}]}}
{"timestamp":"2026-06-22T01:00:04Z","type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}
{"timestamp":"2026-06-22T01:00:05Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"u3"}]}}
{"timestamp":"2026-06-22T01:00:06Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a3"}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	all, err := readCodexImportedExchangeLocators(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 4 {
		t.Fatalf("len(all) = %d, want 4", len(all))
	}
	if all[0].Content != "u1" || all[1].Content != "a1" || all[2].Content != "u3" || all[3].Content != "a3" {
		t.Fatalf("effective exchanges = %#v", all)
	}
	if all[3].CodexUserCountAfter != 2 {
		t.Fatalf("a3 user count = %d, want 2", all[3].CodexUserCountAfter)
	}

	after, err := time.Parse(time.RFC3339, "2026-06-22T01:00:01Z")
	if err != nil {
		t.Fatal(err)
	}
	delta, err := readCodexImportedExchangeLocators(path, after)
	if err != nil {
		t.Fatal(err)
	}
	if len(delta) != 2 {
		t.Fatalf("len(delta) = %d, want 2", len(delta))
	}
	if delta[0].Content != "u3" || delta[1].Content != "a3" {
		t.Fatalf("delta exchanges = %#v", delta)
	}
}

func TestReadCodexImportedSubagentsLinksSpawnCall(t *testing.T) {
	dir := t.TempDir()
	parentPath := filepath.Join(dir, "parent.jsonl")
	childPath := filepath.Join(dir, "child.jsonl")
	parent := `{"timestamp":"2026-07-28T01:00:00Z","type":"session_meta","payload":{"id":"parent","cwd":"/project"}}
{"timestamp":"2026-07-28T01:00:01Z","type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"spawn-1","arguments":"{\"agent_type\":\"explorer\",\"message\":\"inspect importer\"}"}}
{"timestamp":"2026-07-28T01:00:02Z","type":"response_item","payload":{"type":"function_call_output","call_id":"spawn-1","output":"{\"agent_id\":\"child\",\"nickname\":\"Darwin\"}"}}
`
	child := `{"timestamp":"2026-07-28T01:00:03Z","type":"session_meta","payload":{"id":"child","cwd":"/project","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent","depth":1,"agent_nickname":"Darwin","agent_role":"default"}}}}}
{"timestamp":"2026-07-28T01:00:04Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"inspect importer"}]}}
{"timestamp":"2026-07-28T01:00:05Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"found it"}]}}
`
	if err := os.WriteFile(parentPath, []byte(parent), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(childPath, []byte(child), 0o600); err != nil {
		t.Fatal(err)
	}
	importer := NewImporter(ImporterOptions{AgentName: "codex"})
	importer.baseDir = dir
	root, ok, err := inspectCodexSessionFile(parentPath)
	if err != nil || !ok {
		t.Fatalf("inspect parent: ok=%v err=%v", ok, err)
	}
	items, err := importer.readImportedSubagents(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("len(subagents) = %d, want 1: %#v", len(items), items)
	}
	item := items[0]
	if item.AgentSessionID != "child" || item.ParentAgentSessionID != "" ||
		item.ParentToolCallID != "spawn-1" || item.Title != "Darwin" {
		t.Fatalf("subagent = %#v", item)
	}
	if len(item.Exchanges) != 2 {
		t.Fatalf("len(exchanges) = %d, want 2", len(item.Exchanges))
	}
}

func TestReadCodexImportedExchangesIncludesFunctionAndCustomToolCalls(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout.jsonl")
	content := `{"timestamp":"2026-07-28T01:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix it"}]}}
{"timestamp":"2026-07-28T01:00:01Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"checking"}]}}
{"timestamp":"2026-07-28T01:00:02Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"go test ./...\"}","call_id":"call-1"}}
{"timestamp":"2026-07-28T01:00:03Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"{\"output\":\"ok\",\"exit_code\":0}"}}
{"timestamp":"2026-07-28T01:00:04Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch\n*** Update File: server/main.go\n@@\n-old\n+new\n*** Add File: docs/note.md\n+# Note\n*** End Patch","call_id":"call-2","status":"completed"}}
{"timestamp":"2026-07-28T01:00:05Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-2","output":"Done!"}}
{"timestamp":"2026-07-28T01:00:06Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"fixed"}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	items, err := readCodexImportedExchanges(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("len(items) = %d, want 2: %#v", len(items), items)
	}
	assistant := items[1]
	if assistant.Content != "checking\n\nfixed" {
		t.Fatalf("assistant content = %q", assistant.Content)
	}
	if len(assistant.Aux) != 2 {
		t.Fatalf("len(aux) = %d, want 2: %#v", len(assistant.Aux), assistant.Aux)
	}

	command := assistant.Aux[0].ToolCall
	if command == nil || command.CallID != "call-1" ||
		command.Kind != agenttypes.ToolKindExecute || command.Status != "complete" {
		t.Fatalf("command tool call = %#v", command)
	}
	if command.Title != "go test ./..." || command.Meta["command"] != "go test ./..." {
		t.Fatalf("command summary = title %q meta %#v", command.Title, command.Meta)
	}
	if output, _ := command.Meta["output"].(string); output != "ok" {
		t.Fatalf("command output = %#v, want ok", command.Meta["output"])
	}
	if assistant.Aux[0].Line != 1 {
		t.Fatalf("command line = %d, want 1", assistant.Aux[0].Line)
	}

	patch := assistant.Aux[1].ToolCall
	if patch == nil || patch.CallID != "call-2" ||
		patch.Kind != agenttypes.ToolKindEdit || patch.Status != "complete" {
		t.Fatalf("patch tool call = %#v", patch)
	}
	if len(patch.Locations) != 2 ||
		patch.Locations[0].Path != "server/main.go" ||
		patch.Locations[1].Path != "docs/note.md" {
		t.Fatalf("patch locations = %#v", patch.Locations)
	}
	if len(patch.Content) != 2 ||
		patch.Content[0].Path != "server/main.go" ||
		patch.Content[0].ChangeKind != "update" ||
		patch.Content[0].Text != "--- a/server/main.go\n+++ b/server/main.go\n@@\n-old\n+new" ||
		patch.Content[1].Path != "docs/note.md" ||
		patch.Content[1].ChangeKind != "add" ||
		patch.Content[1].Text != "# Note" {
		t.Fatalf("patch content = %#v", patch.Content)
	}
	if output, _ := patch.Meta["output"].(string); output != "Done!" {
		t.Fatalf("patch output = %#v, want Done!", patch.Meta["output"])
	}
}

func TestReadCodexImportedExchangesConvertsProposedPlanToPlanAux(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	content := `{"timestamp":"2026-07-28T01:00:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Here is the plan.\n\n<proposed_plan>\n# Implementation\n\n- Inspect\n- Patch\n</proposed_plan>\n\nLet me know."}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	items, err := readCodexImportedExchanges(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1: %#v", len(items), items)
	}
	if items[0].Content != "Here is the plan.\n\nLet me know." {
		t.Fatalf("content = %q", items[0].Content)
	}
	if len(items[0].Aux) != 1 || items[0].Aux[0].Plan == nil {
		t.Fatalf("aux = %#v, want plan", items[0].Aux)
	}
	if items[0].Aux[0].Plan.Content != "# Implementation\n\n- Inspect\n- Patch" {
		t.Fatalf("plan = %#v", items[0].Aux[0].Plan)
	}
	if items[0].Aux[0].Line != 1 {
		t.Fatalf("plan line = %d, want 1", items[0].Aux[0].Line)
	}
}

func TestParseImportedCodexToolCallStructuresEditArguments(t *testing.T) {
	toolCall, ok := parseImportedCodexToolCall(map[string]any{
		"type":      "function_call",
		"name":      "edit",
		"call_id":   "call-edit",
		"arguments": `{"file_path":"server/main.go","old_string":"old","new_string":"new"}`,
	}, 0)
	if !ok {
		t.Fatal("parseImportedCodexToolCall returned false")
	}
	if toolCall.Title != "server/main.go" ||
		len(toolCall.Locations) != 1 ||
		toolCall.Locations[0].Path != "server/main.go" {
		t.Fatalf("tool call summary = %#v", toolCall)
	}
	if len(toolCall.Content) != 1 ||
		toolCall.Content[0].Type != "diff" ||
		toolCall.Content[0].Path != "server/main.go" ||
		toolCall.Content[0].OldText == nil ||
		*toolCall.Content[0].OldText != "old" ||
		toolCall.Content[0].NewText != "new" {
		t.Fatalf("tool call content = %#v", toolCall.Content)
	}
}

func TestParseImportedCodexToolCallRejectsUnsupportedKinds(t *testing.T) {
	for _, name := range []string{"read_file", "web_search", "spawn_agent"} {
		if toolCall, ok := parseImportedCodexToolCall(map[string]any{
			"type":      "function_call",
			"name":      name,
			"call_id":   "unsupported",
			"arguments": `{}`,
		}, 0); ok {
			t.Fatalf("parseImportedCodexToolCall(%q) = %#v, want rejected", name, toolCall)
		}
	}
}

func TestParseImportedCodexToolCallIncludesAskUser(t *testing.T) {
	toolCall, ok := parseImportedCodexToolCall(map[string]any{
		"type":      "function_call",
		"name":      "request_user_input",
		"call_id":   "ask-1",
		"arguments": `{"questions":[{"question":"Continue?","options":[{"label":"Yes"}]}]}`,
	}, 0)
	if !ok {
		t.Fatal("parseImportedCodexToolCall returned false")
	}
	if toolCall.Kind != agenttypes.ToolKindAskUser || toolCall.Meta["questions"] == nil {
		t.Fatalf("ask-user tool call = %#v", toolCall)
	}
}

func TestImportedCodexAskUserAnswersUsesQuestionOrder(t *testing.T) {
	toolCall, ok := parseImportedCodexToolCall(map[string]any{
		"type":    "function_call",
		"name":    "request_user_input",
		"call_id": "ask-1",
		"arguments": `{"questions":[
			{"id":"scope","question":"Scope?"},
			{"id":"locales","question":"Locales?","multi_select":true}
		]}`,
	}, 0)
	if !ok {
		t.Fatal("parseImportedCodexToolCall returned false")
	}
	answers := importedCodexAskUserAnswers(toolCall, `{
		"answers":{
			"locales":{"answers":["English","Chinese"]},
			"scope":{"answers":["All files"]}
		}
	}`)
	if answers["q_0"] != "All files" || answers["q_1"] != "English, Chinese" {
		t.Fatalf("answers = %#v", answers)
	}
}

func TestParseImportedCodexToolCallIncludesPlan(t *testing.T) {
	toolCall, ok := parseImportedCodexToolCall(map[string]any{
		"type":      "function_call",
		"name":      "update_plan",
		"call_id":   "plan-1",
		"arguments": `{"plan":[{"step":"Inspect","status":"in_progress"}]}`,
	}, 0)
	if !ok {
		t.Fatal("parseImportedCodexToolCall returned false")
	}
	if toolCall.Kind != agenttypes.ToolKindThink || toolCall.Title != "update_plan" {
		t.Fatalf("plan tool call = %#v", toolCall)
	}
	if toolCall.Meta["input"] == nil {
		t.Fatalf("plan meta = %#v, want input", toolCall.Meta)
	}
}

func TestParseImportedCodexToolCallUnwrapsExecOrchestration(t *testing.T) {
	input := `const r = await tools.exec_command({"cmd":"go test ./... && git diff --check","workdir":"/tmp/project","yield_time_ms":30000});
text(r.output);`
	toolCall, ok := parseImportedCodexToolCall(map[string]any{
		"type":    "custom_tool_call",
		"name":    "exec",
		"call_id": "call-exec",
		"input":   input,
	}, 0, "zsh")
	if !ok {
		t.Fatal("parseImportedCodexToolCall returned false")
	}
	wantCommand := `zsh -lc 'go test ./... && git diff --check'`
	if toolCall.Kind != agenttypes.ToolKindExecute ||
		toolCall.Title != wantCommand ||
		toolCall.Meta["command"] != wantCommand {
		t.Fatalf("exec tool call = %#v", toolCall)
	}
}

func TestParseImportedCodexToolCallUnwrapsJavaScriptObjectExec(t *testing.T) {
	input := `const r = await tools.exec_command({cmd:"node -e 'const value={ok:true}; console.log(value)'",workdir:"/tmp/project",yield_time_ms:30000}); text(r.output);`
	toolCall, ok := parseImportedCodexToolCall(map[string]any{
		"type":    "custom_tool_call",
		"name":    "exec",
		"call_id": "call-exec",
		"input":   input,
	}, 0, "zsh")
	if !ok {
		t.Fatal("parseImportedCodexToolCall returned false")
	}
	wantCommand := `zsh -lc 'node -e '\''const value={ok:true}; console.log(value)'\'''`
	if toolCall.Kind != agenttypes.ToolKindExecute ||
		toolCall.Title != wantCommand ||
		toolCall.Meta["command"] != wantCommand ||
		toolCall.Meta["tool"] != "exec_command" {
		t.Fatalf("exec tool call = %#v", toolCall)
	}
}

func TestParseImportedCodexToolCallClassifiesWrappedTools(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantKind  agenttypes.ToolKind
		wantTitle string
		wantPath  string
	}{
		{
			name:      "web search",
			input:     `const r = await tools.web__run({search_query:[{q:"DeepSeek Harness ACP"}],response_length:"long"}); text(r);`,
			wantKind:  agenttypes.ToolKindWebSearch,
			wantTitle: "DeepSeek Harness ACP",
		},
		{
			name:      "patch variable",
			input:     `const patch = "*** Begin Patch\n*** Update File: server/main.go\n@@\n-const tool = tools.exec_command\n+const tool = realCommand\n*** End Patch"; text(await tools.apply_patch(patch));`,
			wantKind:  agenttypes.ToolKindEdit,
			wantTitle: "main.go",
			wantPath:  "server/main.go",
		},
		{
			name:      "write stdin",
			input:     `const r = await tools.write_stdin({session_id:33334,chars:"",yield_time_ms:30000}); text(r);`,
			wantKind:  agenttypes.ToolKindExecute,
			wantTitle: "write_stdin",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			toolCall, ok := parseImportedCodexToolCall(map[string]any{
				"type":    "custom_tool_call",
				"name":    "exec",
				"call_id": "call-1",
				"input":   tt.input,
			}, 0)
			if !ok {
				t.Fatal("parseImportedCodexToolCall returned false")
			}
			if toolCall.Kind != tt.wantKind || toolCall.Title != tt.wantTitle || toolCall.Meta["tool"] == nil {
				t.Fatalf("tool call = %#v", toolCall)
			}
			if tt.wantPath != "" && (len(toolCall.Locations) != 1 || toolCall.Locations[0].Path != tt.wantPath) {
				t.Fatalf("locations = %#v, want %q", toolCall.Locations, tt.wantPath)
			}
		})
	}
}

func TestImportedCodexToolOutputFlattensExecContentBlocks(t *testing.T) {
	raw := []any{
		map[string]any{
			"type": "input_text",
			"text": "Script completed\nWall time 0.8 seconds\nOutput:\n",
		},
		map[string]any{
			"type": "input_text",
			"text": "ok  \tmindfs/server/internal/agent/codex\t0.127s\n" +
				"ok  \tmindfs/server/internal/agent/claude\t(cached)\n",
		},
	}
	output, failed := importedCodexToolOutput(raw)
	if failed {
		t.Fatal("output unexpectedly marked failed")
	}
	output = cleanImportedCodexExecOutput(output)
	want := "ok  \tmindfs/server/internal/agent/codex\t0.127s\n" +
		"ok  \tmindfs/server/internal/agent/claude\t(cached)"
	if output != want {
		t.Fatalf("output = %q, want %q", output, want)
	}
}

func TestReadCodexImportedExchangesUsesRecordedWorldStateShell(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout.jsonl")
	content := `{"timestamp":"2026-07-28T01:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"test it"}]}}
{"timestamp":"2026-07-28T01:00:01Z","type":"world_state","payload":{"full":true,"state":{"environments":{"environments":{"local":{"cwd":"/tmp/project","status":"available","shell":"zsh"}}}}}}
{"timestamp":"2026-07-28T01:00:02Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"const r = await tools.exec_command({\"cmd\":\"go test ./...\",\"workdir\":\"/tmp/project\"});\ntext(r.output);","call_id":"call-exec","status":"completed"}}
{"timestamp":"2026-07-28T01:00:03Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-exec","output":[{"type":"input_text","text":"Script completed\nWall time 0.8 seconds\nOutput:\n"},{"type":"input_text","text":"ok\n"}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	items, err := readCodexImportedExchanges(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || len(items[1].Aux) != 1 || items[1].Aux[0].ToolCall == nil {
		t.Fatalf("imported exchanges = %#v", items)
	}
	toolCall := items[1].Aux[0].ToolCall
	if toolCall.Title != `zsh -lc 'go test ./...'` ||
		toolCall.Meta["command"] != `zsh -lc 'go test ./...'` ||
		toolCall.Meta["output"] != "ok" {
		t.Fatalf("imported exec tool call = %#v", toolCall)
	}
}
