package session

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
	rootfs "mindfs/server/internal/fs"
)

func TestManagerUsesSessionDBLink(t *testing.T) {
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	manager := NewManager(root)

	linkedDB := filepath.Join(t.TempDir(), "session-list.db")
	linkFile := filepath.Join(root.MetaDir(), "sessions", "session-list.db.link")
	if err := writeSessionDBLink(linkFile, linkedDB); err != nil {
		t.Fatalf("write link: %v", err)
	}

	if _, err := manager.Create(context.Background(), CreateInput{Type: TypeChat, Name: "Linked"}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root.MetaDir(), "sessions", "session-list.db")); err == nil {
		t.Fatalf("legacy session-list.db should not be created when link exists")
	}
	if _, err := os.Stat(linkedDB); err != nil {
		t.Fatalf("stat linked db: %v", err)
	}
}

func TestManagerFallsBackToUserDataSessionDBOnSQLitePanic(t *testing.T) {
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("panic-root", "panic-root", rootDir)
	manager := NewManager(root)

	originalOpen := openSQLiteDB
	originalConfigDir := mindFSConfigDir
	defer func() {
		openSQLiteDB = originalOpen
		mindFSConfigDir = originalConfigDir
	}()
	configDir := t.TempDir()
	mindFSConfigDir = func() (string, error) {
		return configDir, nil
	}

	var opened []string
	openSQLiteDB = func(path string) (*sql.DB, error) {
		opened = append(opened, path)
		if strings.Contains(path, rootDir) {
			panic("sqlite legacy panic")
		}
		return originalOpen(path)
	}

	if _, err := manager.Create(context.Background(), CreateInput{Type: TypeChat, Name: "Fallback"}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	if len(opened) < 2 {
		t.Fatalf("opened paths = %#v, want legacy then fallback", opened)
	}
	linkFile := filepath.Join(root.MetaDir(), "sessions", "session-list.db.link")
	payload, err := root.ReadMetaFile("sessions/session-list.db.link")
	if err != nil {
		t.Fatalf("read link: %v", err)
	}
	linked := strings.TrimSpace(string(payload))
	if linked == "" || strings.Contains(linked, rootDir) {
		t.Fatalf("link target = %q, want user-data path", linked)
	}
	if got, ok, err := readSessionDBLink(linkFile); err != nil || !ok || got != linked {
		t.Fatalf("readSessionDBLink = %q, %v, %v; want %q, true, nil", got, ok, err, linked)
	}
}

func TestManagerPersistsParentSessionMetadata(t *testing.T) {
	root := rootfs.NewRootInfo("mindfs", "mindfs", t.TempDir())
	manager := NewManager(root)

	created, err := manager.Create(context.Background(), CreateInput{
		Type:             TypeChat,
		ParentSessionKey: "parent-session",
		ParentToolCallID: "tool-call-1",
		Agent:            "codex",
		Model:            "gpt-test",
		Name:             "Subagent",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	loaded, err := manager.Get(context.Background(), created.Key, 0)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if loaded.ParentSessionKey != "parent-session" {
		t.Fatalf("ParentSessionKey = %q", loaded.ParentSessionKey)
	}
	if loaded.ParentToolCallID != "tool-call-1" {
		t.Fatalf("ParentToolCallID = %q", loaded.ParentToolCallID)
	}
}

func TestManagerPersistsExchangeModelDisplayName(t *testing.T) {
	root := rootfs.NewRootInfo("mindfs", "mindfs", t.TempDir())
	manager := NewManager(root)

	created, err := manager.Create(context.Background(), CreateInput{
		Type:  TypeChat,
		Agent: "claude",
		Model: "opus",
		Name:  "Chat",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	ctx := WithExchangeModelDisplayName(context.Background(), "glm-4.7")
	if err := manager.AddExchangeForAgent(ctx, created, "agent", "reply", "claude", "", "", ""); err != nil {
		t.Fatalf("add exchange: %v", err)
	}

	loaded, err := manager.Get(context.Background(), created.Key, 0)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if len(loaded.Exchanges) != 1 {
		t.Fatalf("exchange count = %d, want 1", len(loaded.Exchanges))
	}
	if got := loaded.Exchanges[0].Model; got != "opus" {
		t.Fatalf("exchange model = %q, want runtime id", got)
	}
	if got := loaded.Exchanges[0].ModelDisplayName; got != "glm-4.7" {
		t.Fatalf("exchange model display name = %q, want snapshot", got)
	}
}

func TestManagerStoresFullToolCallAndReturnsCompactedAux(t *testing.T) {
	root := rootfs.NewRootInfo("mindfs", "mindfs", t.TempDir())
	manager := NewManager(root)

	created, err := manager.Create(context.Background(), CreateInput{
		Type: TypeChat,
		Name: "Chat",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	content := "full search output"
	err = manager.AddExchangeAux(context.Background(), created.Key, ExchangeAux{
		Seq:  2,
		Line: 1,
		ToolCall: &agenttypes.ToolCall{
			CallID:  "call-1",
			Title:   "search",
			Status:  "complete",
			Kind:    agenttypes.ToolKindSearch,
			Content: []agenttypes.ToolCallContentItem{{Type: "text", Text: content}},
			Meta:    map[string]any{"output": content, "query": "full"},
		},
	})
	if err != nil {
		t.Fatalf("add aux: %v", err)
	}

	aux, err := manager.GetExchangeAux(context.Background(), created.Key, 0)
	if err != nil {
		t.Fatalf("get aux: %v", err)
	}
	if len(aux[2]) != 1 || aux[2][0].ToolCall == nil {
		t.Fatalf("aux[2] = %#v, want compacted toolcall", aux[2])
	}
	if len(aux[2][0].ToolCall.Content) != 0 {
		t.Fatalf("compacted content = %#v, want empty", aux[2][0].ToolCall.Content)
	}
	if output, ok := aux[2][0].ToolCall.Meta["output"]; ok {
		t.Fatalf("compacted meta output = %#v, want omitted", output)
	}
	if aux[2][0].ToolCall.Meta["query"] != "full" {
		t.Fatalf("compacted meta = %#v, want non-output keys preserved", aux[2][0].ToolCall.Meta)
	}

	toolCall, err := manager.GetFullToolCall(context.Background(), created.Key, "call-1")
	if err != nil {
		t.Fatalf("get full toolcall: %v", err)
	}
	if len(toolCall.Content) != 1 || !strings.Contains(toolCall.Content[0].Text, content) {
		t.Fatalf("full content = %#v, want %q", toolCall.Content, content)
	}
	if toolCall.Meta["output"] != content {
		t.Fatalf("full meta output = %#v, want %q", toolCall.Meta["output"], content)
	}
}

func TestManagerStoresPlanAndCompactAux(t *testing.T) {
	root := rootfs.NewRootInfo("mindfs", "mindfs", t.TempDir())
	manager := NewManager(root)

	created, err := manager.Create(context.Background(), CreateInput{
		Type: TypeChat,
		Name: "Chat",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	if err := manager.AddExchangeAux(context.Background(), created.Key, ExchangeAux{
		Seq:  2,
		Line: 0,
		Plan: &agenttypes.PlanUpdate{
			ID:      "plan-1",
			Content: "- inspect\n- patch",
		},
	}); err != nil {
		t.Fatalf("add plan aux: %v", err)
	}
	if err := manager.AddExchangeAux(context.Background(), created.Key, ExchangeAux{
		Seq:  2,
		Line: 0,
		Compact: &agenttypes.CompactNotice{
			ID:     "compact-1",
			Status: "complete",
		},
	}); err != nil {
		t.Fatalf("add compact aux: %v", err)
	}

	aux, err := manager.GetExchangeAux(context.Background(), created.Key, 0)
	if err != nil {
		t.Fatalf("get aux: %v", err)
	}
	if len(aux[2]) != 2 {
		t.Fatalf("aux[2] length = %d, want 2: %#v", len(aux[2]), aux[2])
	}
	if aux[2][0].Plan == nil || aux[2][0].Plan.Content != "- inspect\n- patch" {
		t.Fatalf("plan aux = %#v", aux[2][0])
	}
	if aux[2][1].Compact == nil || aux[2][1].Compact.Status != "complete" {
		t.Fatalf("compact aux = %#v", aux[2][1])
	}
}

func TestManagerGetFullToolCallReadsPendingAuxBeforeDisk(t *testing.T) {
	root := rootfs.NewRootInfo("mindfs", "mindfs", t.TempDir())
	manager := NewManager(root)

	created, err := manager.Create(context.Background(), CreateInput{
		Type: TypeChat,
		Name: "Chat",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	callID := "call-pending"
	if err := manager.UpsertPendingExchangeAux(context.Background(), created.Key, ExchangeAux{
		Seq:  2,
		Line: 1,
		ToolCall: &agenttypes.ToolCall{
			CallID:  callID,
			Title:   "git diff",
			Status:  "running",
			Kind:    agenttypes.ToolKindExecute,
			Content: []agenttypes.ToolCallContentItem{{Type: "text", Text: "running output"}},
		},
	}); err != nil {
		t.Fatalf("upsert pending start: %v", err)
	}
	if err := manager.UpsertPendingExchangeAux(context.Background(), created.Key, ExchangeAux{
		Seq:  2,
		Line: 1,
		ToolCall: &agenttypes.ToolCall{
			CallID:  callID,
			Status:  "complete",
			Content: []agenttypes.ToolCallContentItem{{Type: "text", Text: "final diff output"}},
			Meta:    map[string]any{"outputBytes": 17},
		},
	}); err != nil {
		t.Fatalf("upsert pending final: %v", err)
	}

	toolCall, err := manager.GetFullToolCall(context.Background(), created.Key, callID)
	if err != nil {
		t.Fatalf("get pending full toolcall: %v", err)
	}
	if toolCall.Status != "complete" {
		t.Fatalf("status = %q, want complete", toolCall.Status)
	}
	if toolCall.Title != "git diff" {
		t.Fatalf("title = %q, want git diff", toolCall.Title)
	}
	if len(toolCall.Content) != 1 || toolCall.Content[0].Text != "final diff output" {
		t.Fatalf("content = %#v, want final diff output", toolCall.Content)
	}

	manager.ClearPendingExchangeAux(context.Background(), created.Key)
	if _, err := manager.GetFullToolCall(context.Background(), created.Key, callID); err == nil {
		t.Fatal("GetFullToolCall after clear returned nil error, want not found")
	}
}

func TestManagerMarkPendingAskUserAnsweredMergesAnswers(t *testing.T) {
	root := rootfs.NewRootInfo("mindfs", "mindfs", t.TempDir())
	manager := NewManager(root)

	created, err := manager.Create(context.Background(), CreateInput{
		Type: TypeChat,
		Name: "Chat",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	callID := "ask-1"
	questions := []agenttypes.AskUserQuestionItem{{Question: "Pick one"}}
	if err := manager.UpsertPendingExchangeAux(context.Background(), created.Key, ExchangeAux{
		Seq:  2,
		Line: 0,
		ToolCall: &agenttypes.ToolCall{
			CallID: callID,
			Title:  "ask user",
			Status: "running",
			Kind:   agenttypes.ToolKindAskUser,
			Meta: map[string]any{
				"toolUseId": callID,
				"questions": questions,
			},
		},
	}); err != nil {
		t.Fatalf("upsert pending ask user: %v", err)
	}

	answeredAt := time.Date(2026, 6, 22, 1, 2, 3, 0, time.UTC)
	if err := manager.MarkPendingAskUserAnswered(context.Background(), created.Key, callID, map[string]string{
		"q_0": "Yes",
	}, answeredAt); err != nil {
		t.Fatalf("mark answered: %v", err)
	}

	toolCall, err := manager.GetFullToolCall(context.Background(), created.Key, callID)
	if err != nil {
		t.Fatalf("get full toolcall: %v", err)
	}
	if toolCall.Status != "complete" {
		t.Fatalf("status = %q, want complete", toolCall.Status)
	}
	if toolCall.Meta["questions"] == nil {
		t.Fatalf("questions were not preserved: %#v", toolCall.Meta)
	}
	answers, ok := toolCall.Meta["answers"].(map[string]string)
	if !ok || answers["q_0"] != "Yes" {
		t.Fatalf("answers = %#v, want q_0=Yes", toolCall.Meta["answers"])
	}
	if toolCall.Meta["answeredAt"] != answeredAt.Format(time.RFC3339Nano) {
		t.Fatalf("answeredAt = %#v, want %s", toolCall.Meta["answeredAt"], answeredAt.Format(time.RFC3339Nano))
	}
}
