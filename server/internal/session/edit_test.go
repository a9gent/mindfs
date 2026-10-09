package session

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
	rootfs "mindfs/server/internal/fs"
)

func TestReplaceHistoryBeforePersistsPrefixAndInvalidatesBindings(t *testing.T) {
	ctx := context.Background()
	m := NewManager(rootfs.NewRootInfo("edit", "edit", t.TempDir()))
	s, err := m.Create(ctx, CreateInput{Type: TypeChat, Agent: "codex", Name: "Keep name", TaskID: "keep-task"})
	if err != nil {
		t.Fatal(err)
	}
	for i, text := range []string{"first", "answer", "wrong", "wrong answer"} {
		role := "user"
		if i%2 == 1 {
			role = "agent"
		}
		if err := m.AddExchangeForAgent(ctx, s, role, text, "codex", "", "", ""); err != nil {
			t.Fatal(err)
		}
	}
	for _, seq := range []int{2, 4} {
		if err := m.AddExchangeAux(ctx, s.Key, ExchangeAux{Seq: seq, Thought: "thought"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"codex", "claude"} {
		if err := m.UpdateAgentState(ctx, s, name, 4, "old-"+name); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.UpdateExternalSessionCursor(ctx, s.Key, "codex", agenttypes.ExternalSessionCursor{SourcePath: "old", Offset: 100}); err != nil {
		t.Fatal(err)
	}
	original := s.Exchanges[2]
	updated, err := m.ReplaceHistoryBefore(ctx, s.Key, original, &AgentBinding{Agent: "codex", AgentSessionID: "new-codex", AgentCtxSeq: 2})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Key != s.Key || updated.Name != "Keep name" || updated.TaskID != "keep-task" || len(updated.Exchanges) != 2 || updated.HistoryRevision != 1 {
		t.Fatalf("updated: %+v", updated)
	}
	if len(s.Exchanges) != 4 {
		t.Fatal("mutated an existing reader's snapshot")
	}
	// Drop the in-memory cache to verify the committed representation.
	delete(m.sessions, s.Key)
	reloaded, err := m.Get(ctx, s.Key, 0)
	if err != nil || len(reloaded.Exchanges) != 2 || reloaded.HistoryRevision != 1 || reloaded.TaskID != "keep-task" {
		t.Fatalf("reload: %+v %v", reloaded, err)
	}
	for _, name := range []string{"codex", "claude"} {
		b, err := m.FindAgentBinding(ctx, s.Key, name)
		if err != nil {
			t.Fatal(err)
		}
		if name == "claude" && b != nil {
			t.Fatal("stale agent binding survived")
		}
		if name == "codex" && (b == nil || b.AgentSessionID != "new-codex" || b.ExternalSourceOffset != 0 || b.ExternalSourcePath != "") {
			t.Fatalf("binding: %+v", b)
		}
	}
	aux, err := m.loadExchangeAuxEntries(s.Key, 0)
	if err != nil || len(aux) != 1 || aux[0].Seq != 2 {
		t.Fatalf("aux: %+v %v", aux, err)
	}
	if _, err := m.ReplaceHistoryBefore(ctx, s.Key, original, nil); err == nil {
		t.Fatal("accepted stale edit")
	}
	if err := m.AddExchangeForAgent(ctx, reloaded, "user", "correct", "codex", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if reloaded.Exchanges[2].Seq != 3 {
		t.Fatal("incorrect replacement sequence")
	}
}

func TestEditFirstMessageAndRecoverInterruptedWrite(t *testing.T) {
	ctx := context.Background()
	m := NewManager(rootfs.NewRootInfo("edit", "edit", t.TempDir()))
	s, err := m.Create(ctx, CreateInput{Type: TypeChat, Agent: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.AddExchangeForAgentAt(ctx, s, "user", "original", "codex", "", "", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	line, _ := json.Marshal(s.Exchanges[0])
	db, _ := m.ensureSessionMetaDBUnsafe()
	if _, err := db.Exec("INSERT INTO session_edit_journal(session_key,history,auxiliary) VALUES(?,?,?)", s.Key, append(line, '\n'), []byte{}); err != nil {
		t.Fatal(err)
	}
	path, _ := m.exchangePath(s.Key)
	if err := m.root.WriteMetaFile(path, nil); err != nil {
		t.Fatal(err)
	}
	recovered, err := m.Get(ctx, s.Key, 0)
	if err != nil || len(recovered.Exchanges) != 1 || recovered.Exchanges[0].Content != "original" {
		t.Fatalf("recovery: %+v %v", recovered, err)
	}
	updated, err := m.ReplaceHistoryBefore(ctx, s.Key, recovered.Exchanges[0], nil)
	if err != nil || len(updated.Exchanges) != 0 || updated.HistoryRevision != 1 {
		t.Fatalf("first edit: %+v %v", updated, err)
	}
	delete(m.sessions, s.Key)
	reloaded, err := m.Get(ctx, s.Key, 0)
	if err != nil || len(reloaded.Exchanges) != 0 {
		t.Fatalf("reload empty: %+v %v", reloaded, err)
	}
}
