package codex

import (
	"context"
	"encoding/json"
	"testing"

	agenttypes "mindfs/server/internal/agent/types"

	codexsdk "github.com/fanwenlin/codex-go-sdk/codex"
	codextypes "github.com/fanwenlin/codex-go-sdk/types"
)

type closeSessionRPCExec struct {
	method string
	params map[string]any
}

func (e *closeSessionRPCExec) Run(codexsdk.CodexExecArgs) <-chan codexsdk.ExecResult {
	return make(chan codexsdk.ExecResult)
}

func (e *closeSessionRPCExec) RPCCall(_ context.Context, method string, params interface{}) (json.RawMessage, error) {
	e.method = method
	e.params, _ = params.(map[string]any)
	return json.RawMessage(`{}`), nil
}

func TestSessionCloseUnsubscribesCodexThread(t *testing.T) {
	exec := &closeSessionRPCExec{}
	client := codexsdk.NewCodexWithExec(exec, codexsdk.CodexOptions{})
	s := &session{
		client:   client,
		thread:   client.ResumeThread("thread-1", codexsdk.ThreadOptions{}),
		threadID: "thread-1",
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if exec.method != "thread/unsubscribe" || exec.params["threadId"] != "thread-1" {
		t.Fatalf("RPC = %q %#v", exec.method, exec.params)
	}
}

func TestCodexListModelsParamsIncludesHiddenModels(t *testing.T) {
	params := codexListModelsParams()
	if params.IncludeHidden == nil {
		t.Fatal("IncludeHidden is nil")
	}
	if !*params.IncludeHidden {
		t.Fatal("IncludeHidden = false, want true")
	}
}

func TestCodexTokenUsageNormalizesTurnUsage(t *testing.T) {
	got := codexTokenUsage(codexsdk.Usage{
		InputTokens:       12_400,
		CachedInputTokens: 10_168,
		OutputTokens:      1_100,
	})
	if got == nil || got.InputTokens != 12_400 || got.OutputTokens != 1_100 {
		t.Fatalf("usage = %#v", got)
	}
	if got.CacheReadTokens == nil || *got.CacheReadTokens != 10_168 {
		t.Fatalf("cache read = %#v", got.CacheReadTokens)
	}
}

func TestMapCommandExecutionUsesNaturalLanguageTitle(t *testing.T) {
	path := "server"
	query := "TODO"
	output := "ok\n"
	toolCall, ok := mapToolItem(&codexsdk.CommandExecutionItem{
		ID:      "command-1",
		Type:    "commandExecution",
		Command: "go test ./...",
		CommandActions: []codexsdk.CommandAction{{
			Type:  codexsdk.CommandActionTypeSearch,
			Query: &query,
			Path:  &path,
		}},
		AggregatedOutput: &output,
		Status:           codexsdk.CommandExecutionStatusCompleted,
	}, false)
	if !ok {
		t.Fatal("mapToolItem returned false")
	}
	if toolCall.Title != "Search for TODO in server · go test ./..." {
		t.Fatalf("title = %q, want natural-language title", toolCall.Title)
	}
	if toolCall.Meta["command"] != "go test ./..." {
		t.Fatalf("meta = %#v, want original command in details", toolCall.Meta)
	}
}

func TestCodexCommandTitle(t *testing.T) {
	path := "server"
	tests := []struct {
		name    string
		actions []codexsdk.CommandAction
		want    string
	}{
		{name: "no parsed action", want: "go test ./..."},
		{name: "read", actions: []codexsdk.CommandAction{{Type: codexsdk.CommandActionTypeRead, Name: "README.md"}}, want: "Read README.md · go test ./..."},
		{name: "list", actions: []codexsdk.CommandAction{{Type: codexsdk.CommandActionTypeListFiles, Path: &path}}, want: "List files in server · go test ./..."},
		{name: "multiple structured actions", actions: []codexsdk.CommandAction{
			{Type: codexsdk.CommandActionTypeRead, Name: "go.mod"},
			{Type: codexsdk.CommandActionTypeSearch, Path: &path},
		}, want: "Explore files · go test ./..."},
		{name: "multiple including unknown", actions: []codexsdk.CommandAction{
			{Type: codexsdk.CommandActionTypeRead, Name: "go.mod"},
			{Type: codexsdk.CommandActionTypeUnknown},
		}, want: "go test ./..."},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := codexCommandTitle(tc.actions, "go test ./..."); got != tc.want {
				t.Fatalf("codexCommandTitle() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestHandleRawEventPlanDeltaAggregatesPlanUpdates(t *testing.T) {
	s := &session{}
	var updates []agenttypes.Event
	s.OnUpdate(func(event agenttypes.Event) {
		updates = append(updates, event)
	})

	if !s.handleRawEvent(&codexsdk.RawEvent{
		Type: "item.plan.delta",
		Raw:  json.RawMessage(`{"itemId":"plan-1","delta":"# Plan"}`),
	}) {
		t.Fatal("first plan delta was not handled")
	}
	if !s.handleRawEvent(&codexsdk.RawEvent{
		Type: "item/plan/delta",
		Raw:  json.RawMessage(`{"raw":{"itemId":"plan-1","delta":"\n- Step"}}`),
	}) {
		t.Fatal("second plan delta was not handled")
	}

	if len(updates) != 2 {
		t.Fatalf("updates = %d, want 2", len(updates))
	}
	plan, ok := updates[1].Data.(agenttypes.PlanUpdate)
	if !ok {
		t.Fatalf("update data = %T, want PlanUpdate", updates[1].Data)
	}
	if plan.ID != "plan-1" || plan.Content != "# Plan\n- Step" || plan.Delta {
		t.Fatalf("plan = %#v, want aggregated complete content", plan)
	}
}

func TestHandleRawEventTurnPlanUpdatedEmitsTodoUpdate(t *testing.T) {
	s := &session{}
	var got agenttypes.Event
	s.OnUpdate(func(event agenttypes.Event) {
		got = event
	})

	if !s.handleRawEvent(&codexsdk.RawEvent{
		Type: "turn.plan.updated",
		Raw:  json.RawMessage(`{"plan":[{"step":"Inspect","status":"in_progress"},{"step":"Patch","status":"pending"},{"step":"Verify","status":"completed"}]}`),
	}) {
		t.Fatal("turn plan update was not handled")
	}
	if got.Type != agenttypes.EventTypeTodoUpdate {
		t.Fatalf("event type = %q, want todo_update", got.Type)
	}
	todo, ok := got.Data.(agenttypes.TodoUpdate)
	if !ok {
		t.Fatalf("data = %T, want TodoUpdate", got.Data)
	}
	if len(todo.Items) != 3 || todo.Items[0].Status != "in_progress" || todo.Items[2].Status != "completed" {
		t.Fatalf("todo = %#v", todo)
	}
}

func TestMapToolItemWebSearch(t *testing.T) {
	toolCall, ok := mapToolItem(&codexsdk.WebSearchItem{
		ID:    "search-1",
		Type:  "webSearch",
		Query: "codex events",
	}, true)
	if !ok {
		t.Fatal("web search was not mapped")
	}
	if toolCall.Kind != agenttypes.ToolKindWebSearch || toolCall.RawType != "webSearch" {
		t.Fatalf("tool call = %#v", toolCall)
	}
	if toolCall.Title != "codex events" || toolCall.Status != "running" {
		t.Fatalf("tool call title/status = %#v", toolCall)
	}
}

func TestMapToolItemErrorItem(t *testing.T) {
	toolCall, ok := mapToolItem(&codexsdk.ErrorItem{
		ID:      "err-1",
		Type:    "error",
		Message: "non-fatal failure",
	}, false)
	if !ok {
		t.Fatal("error item was not mapped")
	}
	if toolCall.RawType != "error" || toolCall.Status != "failed" || toolCall.Title != "error" {
		t.Fatalf("tool call = %#v", toolCall)
	}
	if len(toolCall.Content) != 1 || toolCall.Content[0].Text != "non-fatal failure" {
		t.Fatalf("content = %#v", toolCall.Content)
	}
}

func TestMapUnknownDynamicToolCall(t *testing.T) {
	toolCall, ok := mapToolItem(&codextypes.UnknownItem{
		Type: "dynamicToolCall",
		Raw:  json.RawMessage(`{"id":"dyn-1","namespace":"ns","tool":"lookup","arguments":{"q":"x"},"status":"completed","contentItems":[{"type":"inputText","text":"result"}],"success":true,"durationMs":7}`),
	}, false)
	if !ok {
		t.Fatal("dynamic tool call was not mapped")
	}
	if toolCall.RawType != "dynamicToolCall" || toolCall.Title != "lookup" || toolCall.Status != "complete" {
		t.Fatalf("tool call = %#v", toolCall)
	}
	if len(toolCall.Content) != 1 || toolCall.Content[0].Text != "result" {
		t.Fatalf("content = %#v", toolCall.Content)
	}
	if toolCall.Meta["namespace"] != "ns" || toolCall.Meta["success"] != true {
		t.Fatalf("meta = %#v", toolCall.Meta)
	}
}

func TestMapUnknownHookPrompt(t *testing.T) {
	toolCall, ok := mapToolItem(&codextypes.UnknownItem{
		Type: "hookPrompt",
		Raw:  json.RawMessage(`{"id":"hook-1","fragments":[{"text":"Retry with tests.","hookRunId":"run-1"},{"text":"Summarize.","hookRunId":"run-2"}]}`),
	}, true)
	if !ok {
		t.Fatal("hook prompt was not mapped")
	}
	if toolCall.RawType != "hookPrompt" || toolCall.Title != "hook prompt" {
		t.Fatalf("tool call = %#v", toolCall)
	}
	if len(toolCall.Content) != 1 || toolCall.Content[0].Text != "Retry with tests.\n\nSummarize." {
		t.Fatalf("content = %#v", toolCall.Content)
	}
}

func TestHandleUnknownPlanAndContextCompactionItems(t *testing.T) {
	s := &session{}
	var updates []agenttypes.Event
	s.OnUpdate(func(event agenttypes.Event) {
		updates = append(updates, event)
	})

	if !s.handleNonToolItem(&codextypes.UnknownItem{
		Type: "plan",
		Raw:  json.RawMessage(`{"id":"plan-2","text":"- Final plan"}`),
	}, false) {
		t.Fatal("unknown plan was not handled")
	}
	if !s.handleNonToolItem(&codextypes.UnknownItem{
		Type: "contextCompaction",
		Raw:  json.RawMessage(`{"id":"compact-1","summary":"Compacted old context"}`),
	}, false) {
		t.Fatal("unknown compaction was not handled")
	}

	if len(updates) != 2 {
		t.Fatalf("updates = %d, want 2", len(updates))
	}
	plan, ok := updates[0].Data.(agenttypes.PlanUpdate)
	if !ok || plan.Content != "- Final plan" {
		t.Fatalf("plan update = %#v", updates[0].Data)
	}
	compact, ok := updates[1].Data.(agenttypes.CompactNotice)
	if !ok || compact.ID != "compact-1" || compact.Status != "complete" {
		t.Fatalf("compact notice = %#v", updates[1].Data)
	}
}
