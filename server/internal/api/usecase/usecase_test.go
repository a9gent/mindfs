package usecase

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	rootfs "mindfs/server/internal/fs"
	"mindfs/server/internal/preferences"
	"mindfs/server/internal/session"
)

func TestSaveUploadedFilesDefaultsToAttachmentDirAndRenamesConflicts(t *testing.T) {
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	service := Service{Registry: uploadTestRegistry{root: root}}

	out, err := service.SaveUploadedFiles(context.Background(), SaveUploadedFilesInput{
		RootID: "mindfs",
		Files: []UploadFile{
			{
				Name:        "demo.txt",
				ContentType: "text/plain; charset=utf-8",
				Reader:      bytes.NewBufferString("first file"),
			},
			{
				Name:        "demo.txt",
				ContentType: "text/plain",
				Reader:      bytes.NewBufferString("second file"),
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveUploadedFiles returned error: %v", err)
	}
	if len(out.Files) != 2 {
		t.Fatalf("expected 2 saved files, got %d", len(out.Files))
	}

	dateDir := time.Now().Format("2006-01-02")
	wantFirst := filepath.ToSlash(filepath.Join(".mindfs", "upload", dateDir, "demo.txt"))
	wantSecond := filepath.ToSlash(filepath.Join(".mindfs", "upload", dateDir, "demo (1).txt"))
	if out.Files[0].Path != wantFirst {
		t.Fatalf("first upload path = %q, want %q", out.Files[0].Path, wantFirst)
	}
	if out.Files[1].Path != wantSecond {
		t.Fatalf("second upload path = %q, want %q", out.Files[1].Path, wantSecond)
	}
	if out.Files[0].Mime != "text/plain" {
		t.Fatalf("first upload mime = %q, want text/plain", out.Files[0].Mime)
	}
	if out.Files[1].Name != "demo (1).txt" {
		t.Fatalf("second upload name = %q, want %q", out.Files[1].Name, "demo (1).txt")
	}

	assertFileContent(t, filepath.Join(rootDir, filepath.FromSlash(wantFirst)), "first file")
	assertFileContent(t, filepath.Join(rootDir, filepath.FromSlash(wantSecond)), "second file")
}

func TestSendCommandMessagePersistsFinalToolCallAndSuggestion(t *testing.T) {
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	manager := session.NewManager(root)
	registry := &commandTestRegistry{root: root, manager: manager}
	service := Service{Registry: registry}

	created, err := manager.Create(context.Background(), session.CreateInput{
		Type: session.TypeCommand,
		Name: "Command",
	})
	if err != nil {
		t.Fatalf("create command session: %v", err)
	}

	var sawStart, sawFinal, sawDone bool
	err = service.SendMessage(context.Background(), SendMessageInput{
		RootID:  root.ID,
		Key:     created.Key,
		Content: "printf mindfs-command",
		OnUpdate: func(event agenttypes.Event) {
			if event.Type == agenttypes.EventTypeMessageDone {
				sawDone = true
				return
			}
			toolCall, ok := event.Data.(agenttypes.ToolCall)
			if !ok {
				return
			}
			if toolCall.Meta["source"] != "userShell" {
				return
			}
			switch toolCall.Meta["phase"] {
			case "start":
				sawStart = true
			case "final":
				sawFinal = true
				if toolCall.Status != "success" {
					t.Fatalf("final status = %q meta=%#v content=%#v, want success", toolCall.Status, toolCall.Meta, toolCall.Content)
				}
				if len(toolCall.Content) == 0 || !strings.Contains(toolCall.Content[0].Text, "mindfs-command") {
					t.Fatalf("final content = %#v, want command output", toolCall.Content)
				}
			}
		},
	})
	if err != nil {
		t.Fatalf("SendMessage command returned error: %v", err)
	}
	if !sawStart || !sawFinal || !sawDone {
		t.Fatalf("events sawStart=%v sawFinal=%v sawDone=%v", sawStart, sawFinal, sawDone)
	}

	current, err := manager.Get(context.Background(), created.Key, 0)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if len(current.Exchanges) != 2 {
		t.Fatalf("exchange count = %d, want 2", len(current.Exchanges))
	}
	aux, err := manager.GetExchangeAux(context.Background(), created.Key, 0)
	if err != nil {
		t.Fatalf("get aux: %v", err)
	}
	if len(aux[2]) != 1 || aux[2][0].ToolCall == nil {
		t.Fatalf("aux[2] = %#v, want final command toolcall", aux[2])
	}

	candidates, err := SearchCommandSuggestions(context.Background(), manager, root.ID, "printf", 10)
	if err != nil {
		t.Fatalf("SearchCommandSuggestions: %v", err)
	}
	if len(candidates) != 1 || candidates[0].Name != "printf mindfs-command" {
		t.Fatalf("candidates = %#v", candidates)
	}
}

func TestSendCommandMessagePersistsCancelledSuggestion(t *testing.T) {
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	manager := session.NewManager(root)
	registry := &commandTestRegistry{root: root, manager: manager}
	service := Service{Registry: registry}

	created, err := manager.Create(context.Background(), session.CreateInput{
		Type: session.TypeCommand,
		Name: "Command",
	})
	if err != nil {
		t.Fatalf("create command session: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	var sawStart, sawCancelled bool
	err = service.SendMessage(ctx, SendMessageInput{
		RootID:  root.ID,
		Key:     created.Key,
		Content: "sleep 10",
		OnUpdate: func(event agenttypes.Event) {
			toolCall, ok := event.Data.(agenttypes.ToolCall)
			if !ok || toolCall.Meta["source"] != "userShell" {
				return
			}
			switch toolCall.Meta["phase"] {
			case "start":
				if !sawStart {
					sawStart = true
					cancel()
				}
			case "final":
				if toolCall.Status == "cancelled" {
					sawCancelled = true
				}
			}
		},
	})
	if err != nil {
		t.Fatalf("SendMessage command returned error: %v", err)
	}
	if !sawStart || !sawCancelled {
		t.Fatalf("events sawStart=%v sawCancelled=%v", sawStart, sawCancelled)
	}

	candidates, err := SearchCommandSuggestions(context.Background(), manager, root.ID, "sleep", 10)
	if err != nil {
		t.Fatalf("SearchCommandSuggestions: %v", err)
	}
	if len(candidates) != 1 || candidates[0].Name != "sleep 10" {
		t.Fatalf("candidates = %#v", candidates)
	}
}

func TestDeleteSessionDeletesSubSessionTree(t *testing.T) {
	ctx := context.Background()
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	manager := session.NewManager(root)
	registry := &commandTestRegistry{root: root, manager: manager}
	service := Service{Registry: registry}

	parent, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, Name: "parent"})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	child, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, ParentSessionKey: parent.Key, Name: "child"})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	grandchild, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, ParentSessionKey: child.Key, Name: "grandchild"})
	if err != nil {
		t.Fatalf("create grandchild: %v", err)
	}
	sibling, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, Name: "sibling"})
	if err != nil {
		t.Fatalf("create sibling: %v", err)
	}

	if err := service.DeleteSession(ctx, DeleteSessionInput{RootID: root.ID, Key: parent.Key}); err != nil {
		t.Fatalf("delete parent: %v", err)
	}
	for _, deleted := range []*session.Session{parent, child, grandchild} {
		if _, err := manager.Get(ctx, deleted.Key, 0); err == nil {
			t.Fatalf("session %s still exists", deleted.Key)
		}
	}
	if _, err := manager.Get(ctx, sibling.Key, 0); err != nil {
		t.Fatalf("sibling should remain: %v", err)
	}
}

func TestSubSessionSyntheticDonePersistsPartialResponse(t *testing.T) {
	ctx := context.Background()
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	manager := session.NewManager(root)
	child, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, Agent: "codex", Name: "child"})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	runtime := &fakeUsecaseAgentSession{id: "sub-thread"}
	var sawDone bool
	markDone := attachBackgroundSessionUpdates(ctx, subagentSessionInput{
		RootID:      root.ID,
		Agent:       "codex",
		Mode:        "default",
		Effort:      "medium",
		FastService: "off",
		Manager:     manager,
		OnUpdate: func(sessionKey string, update agenttypes.Event) {
			if sessionKey == child.Key && update.Type == agenttypes.EventTypeMessageDone {
				sawDone = true
			}
		},
	}, child, runtime)

	runtime.emit(agenttypes.Event{Type: agenttypes.EventTypeMessageChunk, Data: agenttypes.MessageChunk{Content: "partial response"}})
	markDone()

	loaded, err := manager.Get(ctx, child.Key, 0)
	if err != nil {
		t.Fatalf("get child: %v", err)
	}
	if len(loaded.Exchanges) != 1 {
		t.Fatalf("exchanges = %d, want 1", len(loaded.Exchanges))
	}
	if loaded.Exchanges[0].Content != "partial response" {
		t.Fatalf("content = %q", loaded.Exchanges[0].Content)
	}
	if !sawDone {
		t.Fatalf("synthetic done was not emitted")
	}
}

func TestClaudeSubagentRouterCreatesChildSessionAndRoutesChunks(t *testing.T) {
	ctx := context.Background()
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	manager := session.NewManager(root)
	parent, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, Agent: "claude", Name: "parent"})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	var created *session.Session
	var sawDone bool
	router := newClaudeSubagentRouter(subagentSessionInput{
		RootID:  root.ID,
		Parent:  parent,
		Agent:   "claude",
		Model:   "sonnet",
		Mode:    "default",
		Effort:  "medium",
		Manager: manager,
		OnCreated: func(child *session.Session) {
			created = child
		},
		OnUpdate: func(sessionKey string, update agenttypes.Event) {
			if created != nil && sessionKey == created.Key && update.Type == agenttypes.EventTypeMessageDone {
				sawDone = true
			}
		},
	})

	parentTask := agenttypes.ToolCall{
		CallID:  "tool-1",
		Title:   "Review changes",
		Status:  "running",
		Kind:    agenttypes.ToolKindTask,
		RawType: "claude_task",
		Meta: map[string]any{
			"parentToolUseId": "tool-1",
			"taskId":          "task-1",
			"taskDescription": "Review changes",
		},
	}
	if consumed := router.Handle(ctx, agenttypes.Event{Type: agenttypes.EventTypeToolCall, Data: parentTask}); consumed {
		t.Fatalf("parent task lifecycle should not be consumed")
	}
	if created != nil {
		t.Fatalf("parent task lifecycle should not create child")
	}

	if consumed := router.Handle(ctx, agenttypes.Event{
		Type: agenttypes.EventTypeMessageChunk,
		Data: agenttypes.MessageChunk{
			Content:         "child response",
			ParentToolUseID: "tool-1",
			TaskID:          "task-1",
		},
	}); !consumed {
		t.Fatalf("subagent chunk was not consumed")
	}
	if created == nil {
		t.Fatalf("child session was not created")
	}
	if created.ParentSessionKey != parent.Key || created.ParentToolCallID != "tool-1" {
		t.Fatalf("created child parent fields = %#v", created)
	}
	if consumed := router.Handle(ctx, agenttypes.Event{
		Type: agenttypes.EventTypeMessageDone,
		Data: agenttypes.MessageDone{ParentToolUseID: "tool-1", TaskID: "task-1"},
	}); !consumed {
		t.Fatalf("subagent done was not consumed")
	}

	loaded, err := manager.Get(ctx, created.Key, 0)
	if err != nil {
		t.Fatalf("get child: %v", err)
	}
	if len(loaded.Exchanges) != 1 || loaded.Exchanges[0].Content != "child response" {
		t.Fatalf("child exchanges = %#v", loaded.Exchanges)
	}
	if !sawDone {
		t.Fatalf("sub session done update was not emitted")
	}
}

func TestClaudeSubagentRouterDoesNotCreateChildFromTaskIDOnly(t *testing.T) {
	ctx := context.Background()
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	manager := session.NewManager(root)
	parent, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, Agent: "claude", Name: "parent"})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	var createdCount int
	router := newClaudeSubagentRouter(subagentSessionInput{
		RootID:  root.ID,
		Parent:  parent,
		Agent:   "claude",
		Manager: manager,
		OnCreated: func(*session.Session) {
			createdCount++
		},
	})

	taskOnly := agenttypes.ToolCall{
		CallID:  "task-opaque-id",
		Title:   "Task progress",
		Status:  "running",
		Kind:    agenttypes.ToolKindTask,
		RawType: "claude_task",
		Meta: map[string]any{
			"taskId": "task-opaque-id",
		},
	}
	if consumed := router.Handle(ctx, agenttypes.Event{Type: agenttypes.EventTypeToolUpdate, Data: taskOnly}); consumed {
		t.Fatalf("task lifecycle should stay on parent")
	}
	if createdCount != 0 {
		t.Fatalf("createdCount = %d, want 0", createdCount)
	}

	if consumed := router.Handle(ctx, agenttypes.Event{
		Type: agenttypes.EventTypeMessageChunk,
		Data: agenttypes.MessageChunk{Content: "orphan task text", TaskID: "task-opaque-id"},
	}); consumed {
		t.Fatalf("task-id-only chunk should not create child")
	}
	if createdCount != 0 {
		t.Fatalf("createdCount after task chunk = %d, want 0", createdCount)
	}

	if consumed := router.Handle(ctx, agenttypes.Event{
		Type: agenttypes.EventTypeMessageChunk,
		Data: agenttypes.MessageChunk{
			Content:         "subagent text",
			ParentToolUseID: "call_e365874817b34ca79e665ee9",
			TaskID:          "task-opaque-id",
		},
	}); !consumed {
		t.Fatalf("parent-tool-use chunk should create child")
	}
	if createdCount != 1 {
		t.Fatalf("createdCount after parent chunk = %d, want 1", createdCount)
	}
}

func TestDedupeExchangeAuxBufferMergesDuplicateToolCalls(t *testing.T) {
	items := []session.ExchangeAux{
		{
			Seq:  1,
			Line: 0,
			ToolCall: &agenttypes.ToolCall{
				CallID:  "call-1",
				Title:   "Print hi",
				Status:  "running",
				Kind:    agenttypes.ToolKindTask,
				RawType: "tool_use",
				Content: []agenttypes.ToolCallContentItem{{Type: "text", Text: "prompt body"}},
				Meta:    map[string]any{"prompt": "prompt body"},
			},
		},
		{
			Seq:  1,
			Line: 0,
			ToolCall: &agenttypes.ToolCall{
				CallID:  "call-1",
				Status:  "running",
				Kind:    agenttypes.ToolKindTask,
				RawType: "claude_task",
				Meta:    map[string]any{"lastToolName": "Bash"},
			},
		},
	}

	got := dedupeExchangeAuxBuffer(items)
	if len(got) != 1 || got[0].ToolCall == nil {
		t.Fatalf("deduped items = %#v, want one toolcall", got)
	}
	toolCall := got[0].ToolCall
	if toolCall.Title != "Print hi" || toolCall.RawType != "claude_task" {
		t.Fatalf("toolCall latest fields = %#v", toolCall)
	}
	if len(toolCall.Content) != 1 || toolCall.Content[0].Text != "prompt body" {
		t.Fatalf("toolCall content = %#v, want original prompt body", toolCall.Content)
	}
	if toolCall.Meta["prompt"] != "prompt body" || toolCall.Meta["lastToolName"] != "Bash" {
		t.Fatalf("toolCall meta = %#v", toolCall.Meta)
	}
}

func TestShouldPersistToolCallAuxSkipsClaudeTaskProgress(t *testing.T) {
	if shouldPersistToolCallAux(agenttypes.ToolCall{
		CallID:  "call-1",
		Kind:    agenttypes.ToolKindTask,
		RawType: "claude_task",
		Meta:    map[string]any{"subtype": "task_progress"},
	}) {
		t.Fatalf("claude task progress should not persist")
	}
	if !shouldPersistToolCallAux(agenttypes.ToolCall{
		CallID:  "call-1",
		Kind:    agenttypes.ToolKindTask,
		RawType: "claude_task",
		Meta:    map[string]any{"subtype": "task_started"},
	}) {
		t.Fatalf("claude task start should persist")
	}
}

func TestSendCommandMessageUsesLongShellPerSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows long-shell behavior is covered by cross-compile checks")
	}
	rootDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(rootDir, "nested"), 0o755); err != nil {
		t.Fatalf("mkdir nested: %v", err)
	}
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	manager := session.NewManager(root)
	registry := &commandTestRegistry{root: root, manager: manager}
	service := Service{Registry: registry}

	first, err := manager.Create(context.Background(), session.CreateInput{
		Type: session.TypeCommand,
		Name: "Command A",
	})
	if err != nil {
		t.Fatalf("create first command session: %v", err)
	}
	second, err := manager.Create(context.Background(), session.CreateInput{
		Type: session.TypeCommand,
		Name: "Command B",
	})
	if err != nil {
		t.Fatalf("create second command session: %v", err)
	}

	if _, err := sendCommandAndFinal(t, service, root.ID, first.Key, "cd nested"); err != nil {
		t.Fatalf("cd nested: %v", err)
	}
	firstPWD, err := sendCommandAndFinal(t, service, root.ID, first.Key, "pwd")
	if err != nil {
		t.Fatalf("first pwd: %v", err)
	}
	if !strings.Contains(firstPWD, "nested") {
		t.Fatalf("first session pwd = %q, want nested", firstPWD)
	}
	secondPWD, err := sendCommandAndFinal(t, service, root.ID, second.Key, "pwd")
	if err != nil {
		t.Fatalf("second pwd: %v", err)
	}
	if strings.Contains(secondPWD, "nested") {
		t.Fatalf("second session pwd = %q, should not inherit first session cwd", secondPWD)
	}
}

func sendCommandAndFinal(t *testing.T, service Service, rootID, sessionKey, command string) (string, error) {
	t.Helper()
	var final string
	err := service.SendMessage(context.Background(), SendMessageInput{
		RootID:  rootID,
		Key:     sessionKey,
		Content: command,
		OnUpdate: func(event agenttypes.Event) {
			toolCall, ok := event.Data.(agenttypes.ToolCall)
			if !ok || toolCall.Meta["source"] != "userShell" || toolCall.Meta["phase"] != "final" {
				return
			}
			if len(toolCall.Content) > 0 {
				final = toolCall.Content[0].Text
			}
		},
	})
	return final, err
}

func TestSearchCommandCandidatesMergesMindFSAndShellHistory(t *testing.T) {
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	manager := session.NewManager(root)
	if err := UpsertCommandSuggestion(manager, CommandSuggestion{
		Command:      "git status",
		Cwd:          ".",
		Shell:        "zsh",
		RootID:       root.ID,
		LastExitCode: 0,
		LastUsedAt:   time.Now(),
	}); err != nil {
		t.Fatalf("UpsertCommandSuggestion: %v", err)
	}

	historyFile := filepath.Join(rootDir, "zsh_history")
	if err := os.WriteFile(historyFile, []byte(": 1710000000:0;git status\n: 1710000001:0;git stash\n"), 0o644); err != nil {
		t.Fatalf("write zsh history: %v", err)
	}
	t.Setenv("HISTFILE", historyFile)

	candidates, err := SearchCommandCandidates(context.Background(), manager, root.ID, "git st", 10, ShellHistorySpec{Command: "zsh"})
	if err != nil {
		t.Fatalf("SearchCommandCandidates: %v", err)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidates = %#v, want 2", candidates)
	}
	if candidates[0].Name != "git status" || candidates[1].Name != "git stash" {
		t.Fatalf("candidates = %#v", candidates)
	}
}

func TestSaveUploadedFilesUsesExplicitDir(t *testing.T) {
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	service := Service{Registry: uploadTestRegistry{root: root}}

	out, err := service.SaveUploadedFiles(context.Background(), SaveUploadedFilesInput{
		RootID: "mindfs",
		Dir:    "design",
		Files: []UploadFile{
			{
				Name:        "spec.pdf",
				ContentType: "application/pdf",
				Reader:      bytes.NewBufferString("pdf-bytes"),
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveUploadedFiles returned error: %v", err)
	}
	if len(out.Files) != 1 {
		t.Fatalf("expected 1 saved file, got %d", len(out.Files))
	}
	if out.Files[0].Path != "design/spec.pdf" {
		t.Fatalf("saved path = %q, want %q", out.Files[0].Path, "design/spec.pdf")
	}
	assertFileContent(t, filepath.Join(rootDir, "design", "spec.pdf"), "pdf-bytes")
}

func TestFileCandidateProviderSearch(t *testing.T) {
	rootDir := t.TempDir()
	mustWriteFile(t, filepath.Join(rootDir, "design", "18-view-plugin.md"), "a")
	mustWriteFile(t, filepath.Join(rootDir, "design", "14-json-render-refactoring.md"), "a")
	mustWriteFile(t, filepath.Join(rootDir, "node_modules", "pkg", "index.js"), "a")
	mustWriteFile(t, filepath.Join(rootDir, ".git", "config"), "a")
	mustWriteFile(t, filepath.Join(rootDir, ".mindfs", "state.json"), "a")
	mustWriteFile(t, filepath.Join(rootDir, ".DS_Store"), "a")
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)

	provider := NewFileCandidateProvider()
	items, err := provider.Search(context.Background(), root, "", "design")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d: %#v", len(items), items)
	}
	if items[0].Name != "design/18-view-plugin.md" {
		t.Fatalf("expected shorter matching path first, got %q", items[0].Name)
	}
	for _, item := range items {
		switch item.Name {
		case "node_modules/pkg/index.js", ".git/config", ".mindfs/state.json", ".DS_Store":
			t.Fatalf("unexpected filtered path in results: %q", item.Name)
		}
	}
}

func TestRenameManagedDirRenamesDirectoryAndRegistry(t *testing.T) {
	parent := t.TempDir()
	oldPath := filepath.Join(parent, "old-root")
	if err := os.Mkdir(oldPath, 0o755); err != nil {
		t.Fatal(err)
	}
	root := rootfs.NewRootInfo("old-root", "old-root", oldPath)
	registry := &renameManagedDirTestRegistry{root: root}
	service := Service{Registry: registry}

	out, err := service.RenameManagedDir(context.Background(), RenameManagedDirInput{
		RootID: "old-root",
		Name:   "new-root",
	})
	if err != nil {
		t.Fatalf("RenameManagedDir returned error: %v", err)
	}
	if out.OldRootID != "old-root" {
		t.Fatalf("OldRootID = %q, want old-root", out.OldRootID)
	}
	if out.Dir.ID != "new-root" {
		t.Fatalf("renamed ID = %q, want new-root", out.Dir.ID)
	}
	if out.Dir.RootPath != filepath.Join(parent, "new-root") {
		t.Fatalf("renamed path = %q", out.Dir.RootPath)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("old path still exists or stat failed unexpectedly: %v", err)
	}
	if info, err := os.Stat(out.Dir.RootPath); err != nil || !info.IsDir() {
		t.Fatalf("new path was not created as directory: %v", err)
	}
	if !registry.releaseRootResourcesCalled {
		t.Fatal("expected root resources to be released before rename")
	}
}

func TestRenameManagedDirRollsBackDirectoryWhenRegistryFails(t *testing.T) {
	parent := t.TempDir()
	oldPath := filepath.Join(parent, "old-root")
	if err := os.Mkdir(oldPath, 0o755); err != nil {
		t.Fatal(err)
	}
	root := rootfs.NewRootInfo("old-root", "old-root", oldPath)
	registry := &renameManagedDirTestRegistry{
		root:      root,
		renameErr: errors.New("save failed"),
	}
	service := Service{Registry: registry}

	_, err := service.RenameManagedDir(context.Background(), RenameManagedDirInput{
		RootID: "old-root",
		Name:   "new-root",
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if info, statErr := os.Stat(oldPath); statErr != nil || !info.IsDir() {
		t.Fatalf("old path was not restored: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(parent, "new-root")); !os.IsNotExist(statErr) {
		t.Fatalf("new path still exists or stat failed unexpectedly: %v", statErr)
	}
}

func TestSkillCandidateProviderSearch(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	rootDir := t.TempDir()
	mustWriteFile(t, filepath.Join(homeDir, ".codex", "skills", "status", "SKILL.md"), "---\nname: status\ndescription: Home status skill\n---\n")
	mustWriteFile(t, filepath.Join(homeDir, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Shared review skill\n---\n")
	mustWriteFile(t, filepath.Join(rootDir, ".codex", "skills", "status", "SKILL.md"), "---\nname: status\ndescription: Root status skill\n---\n")
	mustWriteFile(t, filepath.Join(rootDir, ".agents", "skills", "trellis-start", "SKILL.md"), "---\nname: trellis-start\ndescription: Start Trellis\n---\n")
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)

	provider := NewSkillCandidateProvider()
	items, err := provider.Search(context.Background(), root, "codex", "")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("expected 3 unique items, got %d: %#v", len(items), items)
	}
	if items[0].Name != "review" && items[0].Name != "status" && items[0].Name != "trellis-start" {
		t.Fatalf("unexpected first item: %#v", items[0])
	}
	descriptionByName := make(map[string]string, len(items))
	for _, item := range items {
		descriptionByName[item.Name] = item.Description
	}
	if got := descriptionByName["status"]; got != "Home status skill" {
		t.Fatalf("expected first scanned status skill to win, got %q", got)
	}
	if got := descriptionByName["review"]; got != "Shared review skill" {
		t.Fatalf("unexpected review description: %q", got)
	}
	if got := descriptionByName["trellis-start"]; got != "Start Trellis" {
		t.Fatalf("unexpected trellis-start description: %q", got)
	}
}

func TestSkillCandidateProviderSearchIncludesCodexPluginCacheSkills(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	rootDir := t.TempDir()
	mustWriteFile(t, filepath.Join(homeDir, ".codex", "plugins", "cache", "openai-primary-runtime", "documents", "26.1.0", "skills", "documents", "SKILL.md"), "---\nname: documents\ndescription: Old documents skill\n---\n")
	mustWriteFile(t, filepath.Join(homeDir, ".codex", "plugins", "cache", "openai-primary-runtime", "documents", "26.10.0", "skills", "documents", "SKILL.md"), "---\nname: documents\ndescription: Current documents skill\n---\n")
	mustWriteFile(t, filepath.Join(homeDir, ".codex", "plugins", "cache", "openai-curated-remote", "product-design", "0.1.47", "skills", "audit", "SKILL.md"), "---\nname: audit\ndescription: Audit product flows\n---\n")
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)

	provider := NewSkillCandidateProvider()
	items, err := provider.Search(context.Background(), root, "codex", "")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	descriptionByName := make(map[string]string, len(items))
	for _, item := range items {
		descriptionByName[item.Name] = item.Description
	}
	if got := descriptionByName["documents"]; got != "Current documents skill" {
		t.Fatalf("documents description = %q, want Current documents skill; items=%#v", got, items)
	}
	if got := descriptionByName["audit"]; got != "Audit product flows" {
		t.Fatalf("audit description = %q, want Audit product flows; items=%#v", got, items)
	}
}

func TestSkillCandidateProviderSearchFollowsSymlinkedSkillDir(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	rootDir := t.TempDir()
	ssotDir := t.TempDir()
	targetDir := filepath.Join(ssotDir, "linked")
	mustWriteFile(t, filepath.Join(targetDir, "SKILL.md"), "---\nname: linked\ndescription: Linked skill\n---\n")
	skillsDir := filepath.Join(homeDir, ".codex", "skills")
	if err := os.MkdirAll(skillsDir, 0o755); err != nil {
		t.Fatalf("mkdir skills dir: %v", err)
	}
	if err := os.Symlink(targetDir, filepath.Join(skillsDir, "linked")); err != nil {
		t.Skipf("symlink not available: %v", err)
	}
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)

	provider := NewSkillCandidateProvider()
	items, err := provider.Search(context.Background(), root, "codex", "linked")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 linked skill, got %d: %#v", len(items), items)
	}
	if items[0].Name != "linked" {
		t.Fatalf("skill name = %q, want linked", items[0].Name)
	}
	if items[0].Description != "Linked skill" {
		t.Fatalf("skill description = %q, want Linked skill", items[0].Description)
	}
}

func TestSkillCandidateProviderSearchExpandsNamespacedSkillBundle(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	rootDir := t.TempDir()
	ssotDir := t.TempDir()
	targetDir := filepath.Join(ssotDir, "aegis-skills")
	mustWriteFile(t, filepath.Join(targetDir, "brainstorming", "SKILL.md"), "---\nname: brainstorming\ndescription: Aegis brainstorm\n---\n")
	mustWriteFile(t, filepath.Join(targetDir, "using-aegis", "SKILL.md"), "---\nname: using-aegis\ndescription: Aegis router\n---\n")
	skillsDir := filepath.Join(homeDir, ".agents", "skills")
	if err := os.MkdirAll(skillsDir, 0o755); err != nil {
		t.Fatalf("mkdir skills dir: %v", err)
	}
	if err := os.Symlink(targetDir, filepath.Join(skillsDir, "aegis")); err != nil {
		t.Skipf("symlink not available: %v", err)
	}
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)

	provider := NewSkillCandidateProvider()
	items, err := provider.Search(context.Background(), root, "codex", "aegis")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 namespaced skills, got %d: %#v", len(items), items)
	}
	descriptionByName := make(map[string]string, len(items))
	for _, item := range items {
		descriptionByName[item.Name] = item.Description
	}
	if _, ok := descriptionByName["aegis"]; ok {
		t.Fatalf("did not expect bare namespace item: %#v", items)
	}
	if got := descriptionByName["aegis:brainstorming"]; got != "Aegis brainstorm" {
		t.Fatalf("unexpected aegis:brainstorming description: %q", got)
	}
	if got := descriptionByName["aegis:using-aegis"]; got != "Aegis router" {
		t.Fatalf("unexpected aegis:using-aegis description: %q", got)
	}
}

func TestSkillCandidateProviderSearchMatchesNamespacedChildName(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	rootDir := t.TempDir()
	mustWriteFile(t, filepath.Join(homeDir, ".agents", "skills", "aegis", "brainstorming", "SKILL.md"), "---\nname: brainstorming\ndescription: Aegis brainstorm\n---\n")
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)

	provider := NewSkillCandidateProvider()
	items, err := provider.Search(context.Background(), root, "codex", "brain")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 namespaced skill, got %d: %#v", len(items), items)
	}
	if items[0].Name != "aegis:brainstorming" {
		t.Fatalf("skill name = %q, want aegis:brainstorming", items[0].Name)
	}
}

func TestSkillCandidateProviderSearchSkipsNonDirectoryScanPath(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	rootDir := t.TempDir()
	mustWriteFile(t, filepath.Join(homeDir, ".codex"), "not a directory")
	mustWriteFile(t, filepath.Join(homeDir, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Shared review skill\n---\n")
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)

	provider := NewSkillCandidateProvider()
	items, err := provider.Search(context.Background(), root, "codex", "")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 skill, got %d: %#v", len(items), items)
	}
	if items[0].Name != "review" {
		t.Fatalf("skill name = %q, want review", items[0].Name)
	}
}

func TestListLocalDirsDefaultsEmptyPathToHome(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	mustWriteFile(t, filepath.Join(homeDir, "project-a", "README.md"), "a")
	if err := os.MkdirAll(filepath.Join(homeDir, "project-b"), 0o755); err != nil {
		t.Fatalf("mkdir project-b: %v", err)
	}

	service := Service{Registry: uploadTestRegistry{}}
	out, err := service.ListLocalDirs(context.Background(), ListLocalDirsInput{})
	if err != nil {
		t.Fatalf("ListLocalDirs returned error: %v", err)
	}
	if out.Path != homeDir {
		t.Fatalf("path = %q, want %q", out.Path, homeDir)
	}
	names := make([]string, 0, len(out.Items))
	for _, item := range out.Items {
		names = append(names, item.Name)
	}
	if strings.Join(names, ",") != "project-a,project-b" {
		t.Fatalf("items = %q, want project-a,project-b", strings.Join(names, ","))
	}
}

func TestCommandCandidatesFromStatus(t *testing.T) {
	provider := NewSlashCommandCandidateProvider(func(agentName string) (agent.Status, bool) {
		if agentName != "claude" {
			return agent.Status{}, false
		}
		return agent.Status{
			Name: "claude",
			Commands: []agenttypes.CommandInfo{
				{Name: "review", Description: "Review current changes"},
				{Name: "memory", Description: "Manage memory"},
			},
		}, true
	})
	items, err := provider.Search(context.Background(), rootfs.RootInfo{}, "claude", "re")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 command candidate, got %d: %#v", len(items), items)
	}
	if items[0].Type != CandidateTypeSlashCommand {
		t.Fatalf("expected slash command candidate, got %#v", items[0])
	}
	if items[0].Name != "review" {
		t.Fatalf("expected review command, got %#v", items[0])
	}
}

func TestCodexSlashCandidatesIncludeTransientCommands(t *testing.T) {
	provider := NewSlashCommandCandidateProvider(func(agentName string) (agent.Status, bool) {
		return agent.Status{Name: agentName}, true
	})
	items, err := provider.Search(context.Background(), rootfs.RootInfo{}, "codex", "lo")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 1 || items[0].Name != "login" {
		t.Fatalf("items = %#v, want login", items)
	}
}

func TestMergeCandidateItemsPreferSlash(t *testing.T) {
	items := mergeCandidateItemsPreferSlash([]CandidateItem{
		{Type: CandidateTypeSlashCommand, Name: "review", Description: "Slash review"},
	}, []CandidateItem{
		{Type: CandidateTypeSkill, Name: "review", Description: "Skill review"},
		{Type: CandidateTypeSkill, Name: "refactor", Description: "Skill refactor"},
	}, "")
	if len(items) != 2 {
		t.Fatalf("expected 2 unique candidates, got %d: %#v", len(items), items)
	}
	if items[0].Type != CandidateTypeSlashCommand || items[0].Name != "review" {
		t.Fatalf("expected slash command to win dedupe, got %#v", items[0])
	}
	if items[1].Name != "refactor" {
		t.Fatalf("expected refactor to remain, got %#v", items[1])
	}
}

func TestPromptStoreAppendMovesExistingToLatestAndLimits(t *testing.T) {
	store := &PromptStore{filePath: filepath.Join(t.TempDir(), "prompts.json")}
	for i := 0; i < maxPromptItems; i++ {
		if _, err := store.Append("prompt-" + strconv.Itoa(i)); err != nil {
			t.Fatalf("Append(%d) returned error: %v", i, err)
		}
	}
	items, err := store.Append("prompt-10")
	if err != nil {
		t.Fatalf("Append(existing) returned error: %v", err)
	}
	if len(items) != maxPromptItems {
		t.Fatalf("expected %d prompts after move, got %d", maxPromptItems, len(items))
	}
	if items[len(items)-1] != "prompt-10" {
		t.Fatalf("expected moved prompt at end, got %q", items[len(items)-1])
	}
	items, err = store.Append("prompt-new")
	if err != nil {
		t.Fatalf("Append(new) returned error: %v", err)
	}
	if len(items) != maxPromptItems {
		t.Fatalf("expected %d prompts after limit, got %d", maxPromptItems, len(items))
	}
	for _, item := range items {
		if item == "prompt-0" {
			t.Fatalf("expected oldest prompt to be trimmed, got %#v", items)
		}
	}
	if items[len(items)-1] != "prompt-new" {
		t.Fatalf("expected newest prompt at end, got %q", items[len(items)-1])
	}
}

func TestPromptCandidateProviderSearchReturnsNewestFirst(t *testing.T) {
	store := &PromptStore{filePath: filepath.Join(t.TempDir(), "prompts.json")}
	for _, item := range []string{"first prompt", "second prompt", "another"} {
		if _, err := store.Append(item); err != nil {
			t.Fatalf("Append(%q) returned error: %v", item, err)
		}
	}
	provider := NewPromptCandidateProvider(store)
	items, err := provider.Search(context.Background(), rootfs.RootInfo{}, "", "prompt")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 prompt matches, got %d: %#v", len(items), items)
	}
	if items[0].Type != CandidateTypePrompt || items[0].Name != "second prompt" {
		t.Fatalf("expected newest prompt first, got %#v", items[0])
	}
	if items[1].Name != "first prompt" {
		t.Fatalf("expected older prompt second, got %#v", items[1])
	}
}

func TestBuildUserPromptSelectionOnly(t *testing.T) {
	got := buildUserPrompt("hello", ClientContext{})
	if strings.Contains(got, "[USER_SELECTION]") {
		t.Fatalf("did not expect user selection block without selection: %q", got)
	}

	got = buildUserPrompt("hello", ClientContext{
		Selection: &Selection{
			FilePath: "design/README.md",
		},
	})
	if !strings.Contains(got, "[USER_SELECTION]\nfile: design/README.md") {
		t.Fatalf("expected file-only user selection block, got %q", got)
	}

	got = buildUserPrompt("hello", ClientContext{
		Selection: &Selection{
			FilePath:  "design/README.md",
			StartLine: 1,
			EndLine:   3,
			Text:      "abc",
		},
	})
	if !strings.Contains(got, "[USER_SELECTION]\nfile: design/README.md") {
		t.Fatalf("expected user selection block, got %q", got)
	}
}

func TestSessionNameScore(t *testing.T) {
	testCases := []struct {
		name    string
		message string
		want    int
	}{
		{name: "empty", message: "", want: 0},
		{name: "chinese", message: "请帮我排查会话列表刷新问题", want: 13},
		{name: "english token counts once", message: "abcdefghijkl", want: 1},
		{name: "mixed", message: "修复 session list refresh", want: 5},
		{name: "punctuation ignored", message: "fix, bug!", want: 2},
		{name: "digits join token", message: "fix v2 api", want: 3},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sessionNameScore(tc.message); got != tc.want {
				t.Fatalf("sessionNameScore(%q) = %d, want %d", tc.message, got, tc.want)
			}
		})
	}
}

func TestNormalizeSessionNameCandidateOnlyCleans(t *testing.T) {
	input := "  \"这是 一个 很长 的 标题 candidate with trailing punctuation!!!\"  "
	want := "这是 一个 很长 的 标题 candidate with trailing punctuation"
	if got := normalizeSessionNameCandidate(input); got != want {
		t.Fatalf("normalizeSessionNameCandidate(%q) = %q, want %q", input, got, want)
	}
}

func TestSessionNameRunnerRealAgent(t *testing.T) {
	if os.Getenv("MINDFS_RUN_REAL_AGENT") != "1" {
		t.Skip("set MINDFS_RUN_REAL_AGENT=1 to run real agent interaction test")
	}

	cfg, err := agent.LoadConfig("")
	if err != nil {
		t.Skipf("LoadConfig failed: %v", err)
	}

	agentName, ok := selectRunnableAgent(cfg)
	if !ok {
		t.Skip("no runnable configured agent found (set MINDFS_IT_AGENT_NAME)")
	}

	pool := agent.NewPool(cfg)
	defer pool.CloseAll()

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	got, err := sessionNameRunner(ctx, pool, t.TempDir(), SuggestSessionNameInput{
		SessionKey:   "real-it-" + time.Now().UTC().Format("20060102-150405"),
		Agent:        agentName,
		FirstMessage: "Please help me investigate why the session list does not refresh immediately after a new session is created.",
	})
	if err != nil {
		t.Fatalf("sessionNameRunner returned error: %v", err)
	}
	if strings.TrimSpace(got) == "" {
		t.Fatal("sessionNameRunner returned empty title")
	}
	if strings.Contains(got, "\n") {
		t.Fatalf("sessionNameRunner returned multi-line title: %q", got)
	}
}

func TestSessionNameRunnerSkipsWithoutAgentOrPool(t *testing.T) {
	testCases := []struct {
		name  string
		input SuggestSessionNameInput
	}{
		{
			name: "missing agent",
			input: SuggestSessionNameInput{
				SessionKey:   "s-1",
				FirstMessage: "hello world session title",
			},
		},
		{
			name: "missing pool",
			input: SuggestSessionNameInput{
				SessionKey:   "s-1",
				Agent:        "codex",
				FirstMessage: "hello world session title",
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := sessionNameRunner(context.Background(), nil, "/tmp/root", tc.input)
			if err != nil || got != "" {
				t.Fatalf("sessionNameRunner = (%q, %v), want empty nil", got, err)
			}
		})
	}
}

func TestAppendResponseChunk(t *testing.T) {
	testCases := []struct {
		name     string
		current  string
		lastType string
		chunk    string
		want     string
	}{
		{
			name:     "plain message append",
			current:  "Hello",
			lastType: string(agenttypes.EventTypeMessageChunk),
			chunk:    " world",
			want:     "Hello world",
		},
		{
			name:     "insert separator after thought",
			current:  "First paragraph.",
			lastType: string(agenttypes.EventTypeThoughtChunk),
			chunk:    "Second paragraph.",
			want:     "First paragraph.\n\nSecond paragraph.",
		},
		{
			name:     "insert separator after tool call update",
			current:  "Result summary.",
			lastType: string(agenttypes.EventTypeToolUpdate),
			chunk:    "Follow-up details.",
			want:     "Result summary.\n\nFollow-up details.",
		},
		{
			name:     "keep existing trailing newline",
			current:  "Result summary.\n",
			lastType: string(agenttypes.EventTypeToolCall),
			chunk:    "Follow-up details.",
			want:     "Result summary.\nFollow-up details.",
		},
		{
			name:     "no prefix on empty response",
			current:  "",
			lastType: string(agenttypes.EventTypeToolCall),
			chunk:    "Fresh text.",
			want:     "Fresh text.",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			if got := appendResponseChunk(tc.current, tc.lastType, tc.chunk); got != tc.want {
				t.Fatalf("appendResponseChunk(%q, %q, %q) = %q, want %q", tc.current, tc.lastType, tc.chunk, got, tc.want)
			}
		})
	}
}

func TestIsNonRecoverableAgentError(t *testing.T) {
	testCases := []struct {
		err  error
		want bool
	}{
		{nil, false},
		{errors.New("codex turn failed: exceeded retry limit, last status: 429 Too Many Requests"), true},
		{errors.New("remote compaction failed while compact_remote retried"), true},
		{errors.New("usageLimitExceeded"), true},
		{errors.New("responseTooManyFailedAttempts"), true},
		{errors.New("temporary websocket EOF"), false},
		{context.Canceled, false},
	}

	for _, tc := range testCases {
		if got := isNonRecoverableAgentError(tc.err); got != tc.want {
			t.Fatalf("isNonRecoverableAgentError(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}

func TestRecoverAgentTurnStopsOnNonRecoverableError(t *testing.T) {
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	manager := session.NewManager(root)
	current, err := manager.Create(context.Background(), session.CreateInput{
		Type:  session.TypeChat,
		Agent: "codex",
		Name:  "chat",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	service := Service{}
	runtime := &fakeUsecaseAgentSession{id: "codex-thread"}
	var sent []string
	gotSess, err := service.recoverAgentTurn(context.Background(), SendRecoveryInput{
		RootID:            root.ID,
		SessionKey:        current.Key,
		Manager:           manager,
		Current:           current,
		AgentName:         "codex",
		CurrentSession:    runtime,
		Prompt:            "original prompt",
		SawAssistantChunk: true,
		SendWithAttachment: func(_ agenttypes.Session, content string) error {
			sent = append(sent, content)
			return errors.New("codex turn failed: exceeded retry limit, last status: 429 Too Many Requests")
		},
	})
	if err == nil {
		t.Fatal("recoverAgentTurn returned nil error")
	}
	if gotSess != nil {
		t.Fatalf("recoverAgentTurn returned session %#v, want nil", gotSess)
	}
	if len(sent) != 1 || sent[0] != "continue" {
		t.Fatalf("sent = %#v, want one continue recovery attempt", sent)
	}
}

func TestCancelRuntimeAfterNonRecoverableErrorClosesSession(t *testing.T) {
	runtime := &fakeUsecaseAgentSession{id: "codex-thread"}

	cancelRuntimeAfterNonRecoverableError(runtime, nil, "codex", errors.New("429 Too Many Requests"))

	if runtime.cancelCalls != 1 {
		t.Fatalf("cancel calls = %d, want 1", runtime.cancelCalls)
	}
	if runtime.closeCalls != 1 {
		t.Fatalf("close calls = %d, want 1", runtime.closeCalls)
	}
}

func assertFileContent(t *testing.T, path string, want string) {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q): %v", path, err)
	}
	if string(payload) != want {
		t.Fatalf("file content = %q, want %q", string(payload), want)
	}
}

func mustWriteFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q): %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func selectRunnableAgent(cfg agent.Config) (string, bool) {
	want := strings.TrimSpace(os.Getenv("MINDFS_IT_AGENT_NAME"))
	if want != "" {
		def, ok := cfg.GetAgent(want)
		if !ok {
			return "", false
		}
		if _, err := exec.LookPath(def.Command); err != nil {
			return "", false
		}
		return want, true
	}

	for _, name := range []string{"codex", "claude", "gemini"} {
		def, ok := cfg.GetAgent(name)
		if !ok {
			continue
		}
		if _, err := exec.LookPath(def.Command); err != nil {
			continue
		}
		return name, true
	}
	return "", false
}

type uploadTestRegistry struct {
	root rootfs.RootInfo
}

func (r uploadTestRegistry) GetRoot(rootID string) (rootfs.RootInfo, error) {
	if rootID != r.root.ID {
		return rootfs.RootInfo{}, errors.New("root not found")
	}
	return r.root, nil
}

func (uploadTestRegistry) GetSessionManager(string) (*session.Manager, error) {
	return nil, nil
}

func (uploadTestRegistry) UpsertRoot(string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}

func (uploadTestRegistry) RemoveRoot(string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}

func (uploadTestRegistry) RenameRoot(string, string, string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}

func (uploadTestRegistry) ListRoots() []rootfs.RootInfo {
	return nil
}

func (uploadTestRegistry) GetAgentPool() *agent.Pool {
	return nil
}

func (uploadTestRegistry) GetPreferences() *preferences.Store {
	return nil
}

func (uploadTestRegistry) GetExternalSessionImporter(string) (agenttypes.ExternalSessionImporter, error) {
	return nil, errors.New("not implemented")
}

func (uploadTestRegistry) GetProber() *agent.Prober {
	return nil
}

func (uploadTestRegistry) GetCandidateRegistry() *CandidateRegistry {
	return nil
}

func (uploadTestRegistry) GetFileWatcher(string, *session.Manager) (*rootfs.SharedFileWatcher, error) {
	return nil, nil
}

func (uploadTestRegistry) ReleaseFileWatcher(string, string) {}

type fakeUsecaseAgentSession struct {
	id          string
	cancelCalls int
	closeCalls  int
	onUpdate    func(agenttypes.Event)
}

func (s *fakeUsecaseAgentSession) SendMessage(context.Context, string) error { return nil }

func (s *fakeUsecaseAgentSession) AnswerQuestion(context.Context, agenttypes.AskUserAnswer) error {
	return nil
}

func (s *fakeUsecaseAgentSession) CurrentModel() string { return "" }

func (s *fakeUsecaseAgentSession) SetModel(context.Context, string) error { return nil }

func (s *fakeUsecaseAgentSession) ListModels(context.Context) (agenttypes.ModelList, error) {
	return agenttypes.ModelList{}, nil
}

func (s *fakeUsecaseAgentSession) SetMode(context.Context, string) error { return nil }

func (s *fakeUsecaseAgentSession) SetPlanMode(context.Context, bool) error { return nil }

func (s *fakeUsecaseAgentSession) ListModes(context.Context) (agenttypes.ModeList, error) {
	return agenttypes.ModeList{}, nil
}

func (s *fakeUsecaseAgentSession) ListCommands(context.Context) (agenttypes.CommandList, error) {
	return agenttypes.CommandList{}, nil
}

func (s *fakeUsecaseAgentSession) CancelCurrentTurn() error {
	s.cancelCalls++
	return nil
}

func (s *fakeUsecaseAgentSession) OnUpdate(onUpdate func(agenttypes.Event)) {
	s.onUpdate = onUpdate
}

func (s *fakeUsecaseAgentSession) SessionID() string { return s.id }

func (s *fakeUsecaseAgentSession) ContextWindow(context.Context) (agenttypes.ContextWindow, error) {
	return agenttypes.ContextWindow{}, nil
}

func (s *fakeUsecaseAgentSession) Close() error {
	s.closeCalls++
	return nil
}

func (s *fakeUsecaseAgentSession) emit(event agenttypes.Event) {
	if s.onUpdate != nil {
		s.onUpdate(event)
	}
}

func TestCancelSessionTurnCancelsTransientActiveTurn(t *testing.T) {
	rootDir := t.TempDir()
	root := rootfs.NewRootInfo("mindfs", "mindfs", rootDir)
	manager := session.NewManager(root)
	service := Service{Registry: &commandTestRegistry{root: root, manager: manager}}
	sessionKey := "transient-login-test"
	turnCtx, cancel := context.WithCancel(context.Background())
	fakeSession := &fakeUsecaseAgentSession{}
	registerActiveTurn(root.ID, sessionKey, cancel)
	setActiveTurnSession(root.ID, sessionKey, fakeSession)
	defer unregisterActiveTurn(root.ID, sessionKey)

	if err := service.CancelSessionTurn(context.Background(), CancelSessionTurnInput{
		RootID: root.ID,
		Key:    sessionKey,
	}); err != nil {
		t.Fatalf("CancelSessionTurn returned error: %v", err)
	}
	if turnCtx.Err() == nil {
		t.Fatal("expected transient turn context to be canceled")
	}
	if fakeSession.cancelCalls != 1 {
		t.Fatalf("CancelCurrentTurn calls = %d, want 1", fakeSession.cancelCalls)
	}
}

type commandTestRegistry struct {
	root    rootfs.RootInfo
	manager *session.Manager
}

func (r *commandTestRegistry) GetRoot(rootID string) (rootfs.RootInfo, error) {
	if rootID != r.root.ID {
		return rootfs.RootInfo{}, errors.New("root not found")
	}
	return r.root, nil
}

func (r *commandTestRegistry) GetSessionManager(string) (*session.Manager, error) {
	return r.manager, nil
}

func (r *commandTestRegistry) UpsertRoot(string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}

func (r *commandTestRegistry) RemoveRoot(string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}

func (r *commandTestRegistry) RenameRoot(string, string, string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}

func (r *commandTestRegistry) ListRoots() []rootfs.RootInfo {
	return []rootfs.RootInfo{r.root}
}

func (r *commandTestRegistry) GetAgentPool() *agent.Pool {
	return nil
}

func (r *commandTestRegistry) GetPreferences() *preferences.Store {
	return nil
}

func (r *commandTestRegistry) GetExternalSessionImporter(string) (agenttypes.ExternalSessionImporter, error) {
	return nil, errors.New("not implemented")
}

func (r *commandTestRegistry) GetProber() *agent.Prober {
	return nil
}

func (r *commandTestRegistry) GetCandidateRegistry() *CandidateRegistry {
	return NewCandidateRegistry()
}

func (r *commandTestRegistry) GetFileWatcher(string, *session.Manager) (*rootfs.SharedFileWatcher, error) {
	return nil, nil
}

func (r *commandTestRegistry) ReleaseFileWatcher(string, string) {}

type renameManagedDirTestRegistry struct {
	root                       rootfs.RootInfo
	others                     []rootfs.RootInfo
	renameErr                  error
	releaseRootResourcesCalled bool
}

func (r *renameManagedDirTestRegistry) GetRoot(rootID string) (rootfs.RootInfo, error) {
	if rootID != r.root.ID {
		return rootfs.RootInfo{}, errors.New("root not found")
	}
	return r.root, nil
}

func (*renameManagedDirTestRegistry) GetSessionManager(string) (*session.Manager, error) {
	return nil, nil
}

func (*renameManagedDirTestRegistry) UpsertRoot(string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}

func (*renameManagedDirTestRegistry) RemoveRoot(string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}

func (r *renameManagedDirTestRegistry) RenameRoot(rootID, name, rootPath string) (rootfs.RootInfo, error) {
	if r.renameErr != nil {
		return rootfs.RootInfo{}, r.renameErr
	}
	if rootID != r.root.ID {
		return rootfs.RootInfo{}, errors.New("root not found")
	}
	r.root.ID = name
	r.root.Name = name
	r.root.RootPath = filepath.Clean(rootPath)
	return r.root, nil
}

func (r *renameManagedDirTestRegistry) ReleaseRootResources(string) {
	r.releaseRootResourcesCalled = true
}

func (r *renameManagedDirTestRegistry) ListRoots() []rootfs.RootInfo {
	roots := []rootfs.RootInfo{r.root}
	roots = append(roots, r.others...)
	return roots
}

func (*renameManagedDirTestRegistry) GetAgentPool() *agent.Pool {
	return nil
}

func (*renameManagedDirTestRegistry) GetPreferences() *preferences.Store {
	return nil
}

func (*renameManagedDirTestRegistry) GetExternalSessionImporter(string) (agenttypes.ExternalSessionImporter, error) {
	return nil, errors.New("not implemented")
}

func (*renameManagedDirTestRegistry) GetProber() *agent.Prober {
	return nil
}

func (*renameManagedDirTestRegistry) GetCandidateRegistry() *CandidateRegistry {
	return nil
}

func (*renameManagedDirTestRegistry) GetFileWatcher(string, *session.Manager) (*rootfs.SharedFileWatcher, error) {
	return nil, nil
}

func (*renameManagedDirTestRegistry) ReleaseFileWatcher(string, string) {}
