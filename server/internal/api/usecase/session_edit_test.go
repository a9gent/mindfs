package usecase

import (
	"context"
	"mindfs/server/internal/agent"
	rootfs "mindfs/server/internal/fs"
	"mindfs/server/internal/session"
	"testing"
	"time"
)

func TestValidateEditTarget(t *testing.T) {
	now := time.Now()
	s := &session.Session{Type: session.TypeChat, Exchanges: []session.Exchange{
		{Seq: 1, Role: "user", Content: "first", Timestamp: now},
		{Seq: 2, Role: "agent", Content: "reply", Timestamp: now},
		{Seq: 3, Role: "user", Content: "wrong", Timestamp: now},
	}}
	for _, tc := range []struct {
		seq   int
		text  string
		stamp time.Time
		valid bool
	}{
		{3, "wrong", now, true}, {0, "wrong", now, true}, {1, "first", now, false}, {3, "changed", now, false}, {3, "wrong", now.Add(time.Second), false},
	} {
		_, err := ValidateEditTarget(s, EditSessionMessageInput{Seq: tc.seq, OriginalContent: tc.text, OriginalTimestamp: tc.stamp})
		if (err == nil) != tc.valid {
			t.Fatalf("%+v: %v", tc, err)
		}
	}
	s.TaskID = "task"
	if _, err := ValidateEditTarget(s, EditSessionMessageInput{Seq: 3, OriginalContent: "wrong", OriginalTimestamp: now}); err != nil {
		t.Fatalf("open task chat rejected: %v", err)
	}
	s.ClosedAt = &now
	if _, err := ValidateEditTarget(s, EditSessionMessageInput{Seq: 3, OriginalContent: "wrong", OriginalTimestamp: now}); err == nil {
		t.Fatal("closed task session accepted")
	}
}

type editTestRegistry struct {
	*commandTestRegistry
	pool *agent.Pool
}

func (r *editTestRegistry) GetAgentPool() *agent.Pool { return r.pool }

func TestEditForkFailureKeepsOriginalHistory(t *testing.T) {
	ctx := context.Background()
	root := rootfs.NewRootInfo("edit", "edit", t.TempDir())
	m := session.NewManager(root)
	s, err := m.Create(ctx, session.CreateInput{Type: session.TypeChat, Agent: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	for i, text := range []string{"first", "answer", "wrong", "reply"} {
		role := "user"
		if i%2 == 1 {
			role = "agent"
		}
		if err := m.AddExchangeForAgent(ctx, s, role, text, "codex", "", "", ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.UpdateAgentState(ctx, s, "codex", 4, "old"); err != nil {
		t.Fatal(err)
	}
	pool := agent.NewPool(agent.Config{Agents: []agent.Definition{{Name: "codex", Protocol: agent.ProtocolCodexSDK, Command: "unused"}}})
	defer pool.CloseAll()
	uc := Service{Registry: &editTestRegistry{commandTestRegistry: &commandTestRegistry{root: root, manager: m}, pool: pool}}
	target := s.Exchanges[2]
	_, _, err = uc.PrepareEditedSession(ctx, EditSessionMessageInput{RootID: root.ID, Key: s.Key, Seq: 3, OriginalContent: target.Content, OriginalTimestamp: target.Timestamp})
	if err == nil {
		t.Fatal("expected missing native fork resolver failure")
	}
	unchanged, _ := m.Get(ctx, s.Key, 0)
	binding, _ := m.FindAgentBinding(ctx, s.Key, "codex")
	if len(unchanged.Exchanges) != 4 || unchanged.HistoryRevision != 0 || binding == nil || binding.AgentSessionID != "old" {
		t.Fatal("failed preparation changed original history")
	}
	if _, err := m.ReplaceHistoryBefore(ctx, s.Key, target, nil); err != nil {
		t.Fatal(err)
	}
	// A stale sequence cursor needs the full prefix after an edit, even when
	// the server now has fewer messages than the client's previous cursor.
	full, err := uc.GetSession(ctx, GetSessionInput{RootID: root.ID, Key: s.Key, Seq: 4, HistoryRevision: 0})
	if err != nil || len(full.Exchanges) != 2 || full.HistoryRevision != 1 {
		t.Fatalf("stale cursor: %+v %v", full, err)
	}
	delta, err := uc.GetSession(ctx, GetSessionInput{RootID: root.ID, Key: s.Key, Seq: 2, HistoryRevision: 1})
	if err != nil || len(delta.Exchanges) != 0 {
		t.Fatalf("current cursor: %+v %v", delta, err)
	}
}
