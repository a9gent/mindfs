package acp

import (
	"errors"
	"io"
	"os"
	"testing"
	"time"

	types "mindfs/server/internal/agent/types"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestIsExpectedStreamCloseError(t *testing.T) {
	for _, err := range []error{nil, os.ErrClosed, io.ErrClosedPipe, &os.PathError{Op: "read", Path: "|0", Err: os.ErrClosed}} {
		if !isExpectedStreamCloseError(err) {
			t.Fatalf("error %v should be treated as an expected stream close", err)
		}
	}
	if isExpectedStreamCloseError(errors.New("unexpected read failure")) {
		t.Fatal("unexpected read failure was suppressed")
	}
}

func TestACPTokenUsageConvertsCumulativeCountersToTurnDelta(t *testing.T) {
	state := &sessionState{}
	firstRead, firstWrite := 4_000, 1_000
	first := state.tokenUsageDelta(&acpsdk.Usage{
		InputTokens:       5_500,
		OutputTokens:      500,
		CachedReadTokens:  &firstRead,
		CachedWriteTokens: &firstWrite,
	})
	if first == nil || first.InputTokens != 5_500 || first.OutputTokens != 500 {
		t.Fatalf("first usage = %#v", first)
	}

	secondRead, secondWrite := 12_000, 1_500
	second := state.tokenUsageDelta(&acpsdk.Usage{
		InputTokens:       14_000,
		OutputTokens:      1_600,
		CachedReadTokens:  &secondRead,
		CachedWriteTokens: &secondWrite,
	})
	if second == nil || second.InputTokens != 8_500 || second.OutputTokens != 1_100 {
		t.Fatalf("second usage = %#v", second)
	}
	if second.CacheReadTokens == nil || *second.CacheReadTokens != 8_000 {
		t.Fatalf("second cache read = %#v", second.CacheReadTokens)
	}
	if second.CacheWriteTokens == nil || *second.CacheWriteTokens != 500 {
		t.Fatalf("second cache write = %#v", second.CacheWriteTokens)
	}
}

func TestCloseProcessesConcurrentlyDoesNotSerializeWaits(t *testing.T) {
	procs := []*Process{{agentName: "first"}, {agentName: "second"}}
	started := make(chan string, len(procs))
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		closeProcessesConcurrently(procs, func(proc *Process) error {
			started <- proc.agentLabel()
			<-release
			return nil
		})
		close(done)
	}()

	seen := make(map[string]bool, len(procs))
	for range procs {
		select {
		case name := <-started:
			seen[name] = true
		case <-time.After(time.Second):
			t.Fatal("process closes were serialized")
		}
	}
	if !seen["first"] || !seen["second"] {
		t.Fatalf("started closes = %v", seen)
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("concurrent process closes did not complete")
	}
}

func TestWrapSessionUpdateRecognizesPlan(t *testing.T) {
	update := wrapSessionUpdate("session-1", acpsdk.SessionUpdate{
		Plan: &acpsdk.SessionUpdatePlan{
			Entries: []acpsdk.PlanEntry{{Content: "Inspect files", Status: acpsdk.PlanEntryStatusPending}},
		},
	})
	if update.Type != UpdateTypePlan {
		t.Fatalf("update.Type = %q, want %q", update.Type, UpdateTypePlan)
	}
}

func TestMapModelStateUsesLegacyACPModels(t *testing.T) {
	models := mapModelState(&acpsdk.SessionModelState{
		CurrentModelId: acpsdk.ModelId("gpt-4.1"),
		AvailableModels: []acpsdk.ModelInfo{
			{
				ModelId:     acpsdk.ModelId("gpt-4.1"),
				Name:        "GPT-4.1",
				Description: acpsdk.Ptr("Fast model"),
			},
		},
	})
	if models.CurrentModelID != "gpt-4.1" {
		t.Fatalf("CurrentModelID = %q", models.CurrentModelID)
	}
	if len(models.Models) != 1 {
		t.Fatalf("Models = %#v", models.Models)
	}
	if got := models.Models[0]; got.ID != "gpt-4.1" || got.Name != "GPT-4.1" || got.Description != "Fast model" {
		t.Fatalf("model = %#v", got)
	}
}

func TestConvertEventMapsACPPlanToTodoUpdate(t *testing.T) {
	event := convertEvent(SessionUpdate{
		Type:      UpdateTypePlan,
		SessionID: "session-1",
		Raw: acpsdk.SessionUpdate{
			Plan: &acpsdk.SessionUpdatePlan{
				Entries: []acpsdk.PlanEntry{
					{Content: "Inspect files", Status: acpsdk.PlanEntryStatusPending},
					{Content: "Patch implementation", Status: acpsdk.PlanEntryStatusInProgress},
					{Content: "Run tests", Status: acpsdk.PlanEntryStatusCompleted},
				},
			},
		},
	})
	if event.Type != types.EventTypeTodoUpdate {
		t.Fatalf("event.Type = %q, want %q", event.Type, types.EventTypeTodoUpdate)
	}
	todo, ok := event.Data.(types.TodoUpdate)
	if !ok {
		t.Fatalf("event.Data = %T, want TodoUpdate", event.Data)
	}
	if len(todo.Items) != 3 {
		t.Fatalf("todo.Items = %#v, want 3 items", todo.Items)
	}
	if todo.Items[0].Content != "Inspect files" || todo.Items[0].Status != "pending" {
		t.Fatalf("todo.Items[0] = %#v", todo.Items[0])
	}
	if todo.Items[1].Content != "Patch implementation" || todo.Items[1].Status != "in_progress" {
		t.Fatalf("todo.Items[1] = %#v", todo.Items[1])
	}
	if todo.Items[2].Content != "Run tests" || todo.Items[2].Status != "completed" {
		t.Fatalf("todo.Items[2] = %#v", todo.Items[2])
	}
}

func TestConvertEventPreservesACPHumanReadableToolTitle(t *testing.T) {
	event := convertEvent(SessionUpdate{
		Type:      UpdateTypeToolCall,
		SessionID: "session-1",
		Raw: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tool-1",
				Title:      "Run the test suite",
				Kind:       acpsdk.ToolKindExecute,
				Status:     acpsdk.ToolCallStatusInProgress,
			},
		},
	})
	toolCall, ok := event.Data.(types.ToolCall)
	if !ok {
		t.Fatalf("event.Data = %T, want ToolCall", event.Data)
	}
	if toolCall.Title != "Run the test suite" {
		t.Fatalf("title = %q, want ACP human-readable title", toolCall.Title)
	}
}

func TestConvertEventMapsACPPlanUpdateMarkdownAndFileToPlanUpdate(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  acpsdk.SessionUpdate
		want types.PlanUpdate
	}{
		{
			name: "markdown",
			raw: acpsdk.SessionUpdate{
				PlanUpdate: &acpsdk.SessionPlanUpdate{
					Plan: acpsdk.PlanUpdateContent{
						Markdown: &acpsdk.PlanUpdateContentMarkdown{
							Id:      "plan-1",
							Content: "## Plan\n\n- Step",
						},
					},
				},
			},
			want: types.PlanUpdate{ID: "plan-1", Content: "## Plan\n\n- Step"},
		},
		{
			name: "file",
			raw: acpsdk.SessionUpdate{
				PlanUpdate: &acpsdk.SessionPlanUpdate{
					Plan: acpsdk.PlanUpdateContent{
						File: &acpsdk.PlanUpdateContentFile{
							Id:  "plan-3",
							Uri: "file:///tmp/PLAN.md",
						},
					},
				},
			},
			want: types.PlanUpdate{ID: "plan-3", Content: "Plan file: file:///tmp/PLAN.md"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			event := convertEvent(SessionUpdate{
				Type:      UpdateTypePlan,
				SessionID: "session-1",
				Raw:       tc.raw,
			})
			if event.Type != types.EventTypePlanUpdate {
				t.Fatalf("event.Type = %q, want %q", event.Type, types.EventTypePlanUpdate)
			}
			got, ok := event.Data.(types.PlanUpdate)
			if !ok {
				t.Fatalf("event.Data = %T, want PlanUpdate", event.Data)
			}
			if got != tc.want {
				t.Fatalf("plan = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestConvertEventMapsACPPlanUpdateItemsToTodoUpdate(t *testing.T) {
	event := convertEvent(SessionUpdate{
		Type:      UpdateTypePlan,
		SessionID: "session-1",
		Raw: acpsdk.SessionUpdate{
			PlanUpdate: &acpsdk.SessionPlanUpdate{
				Plan: acpsdk.PlanUpdateContent{
					Items: &acpsdk.PlanUpdateContentItems{
						Id: "plan-2",
						Entries: []acpsdk.PlanEntry{
							{Content: "Verify behavior", Status: acpsdk.PlanEntryStatusCompleted},
						},
					},
				},
			},
		},
	})
	if event.Type != types.EventTypeTodoUpdate {
		t.Fatalf("event.Type = %q, want %q", event.Type, types.EventTypeTodoUpdate)
	}
	todo, ok := event.Data.(types.TodoUpdate)
	if !ok {
		t.Fatalf("event.Data = %T, want TodoUpdate", event.Data)
	}
	if len(todo.Items) != 1 || todo.Items[0].Content != "Verify behavior" || todo.Items[0].Status != "completed" {
		t.Fatalf("todo = %#v", todo)
	}
}

func TestConvertEventSuppressesACPTodoWriteToolCards(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  acpsdk.SessionUpdate
		typ  UpdateType
	}{
		{
			name: "pending todowrite",
			typ:  UpdateTypeToolCall,
			raw: acpsdk.SessionUpdate{
				ToolCall: &acpsdk.SessionUpdateToolCall{
					ToolCallId: "call-1",
					Title:      "todowrite",
					Kind:       acpsdk.ToolKindOther,
					Status:     acpsdk.ToolCallStatusPending,
					RawInput:   map[string]any{},
				},
			},
		},
		{
			name: "complete todowrite",
			typ:  UpdateTypeToolUpdate,
			raw: acpsdk.SessionUpdate{
				ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
					ToolCallId: "call-1",
					Title:      acpsdk.Ptr("todowrite"),
					Kind:       acpsdk.Ptr(acpsdk.ToolKindOther),
					Status:     acpsdk.Ptr(acpsdk.ToolCallStatusCompleted),
					RawInput:   map[string]any{"todos": []any{map[string]any{"content": "Inspect", "status": "pending"}}},
				},
			},
		},
		{
			name: "summary todos",
			typ:  UpdateTypeToolUpdate,
			raw: acpsdk.SessionUpdate{
				ToolCallUpdate: &acpsdk.SessionToolCallUpdate{
					ToolCallId: "call-1",
					Title:      acpsdk.Ptr("5 todos"),
					Kind:       acpsdk.Ptr(acpsdk.ToolKindOther),
					Status:     acpsdk.Ptr(acpsdk.ToolCallStatusCompleted),
					RawOutput:  map[string]any{"metadata": map[string]any{"todos": []any{map[string]any{"content": "Inspect", "status": "pending"}}}},
				},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			event := convertEvent(SessionUpdate{
				Type:      tc.typ,
				SessionID: "session-1",
				Raw:       tc.raw,
			})
			if event.Type != "" {
				t.Fatalf("event = %#v, want suppressed empty event", event)
			}
		})
	}
}
