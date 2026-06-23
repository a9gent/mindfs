package codex

import (
	"encoding/json"
	"testing"

	agenttypes "mindfs/server/internal/agent/types"

	codexsdk "github.com/fanwenlin/codex-go-sdk/codex"
	codextypes "github.com/fanwenlin/codex-go-sdk/types"
)

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
