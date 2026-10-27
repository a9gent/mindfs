package usecase

import (
	"context"
	"testing"

	rootfs "mindfs/server/internal/fs"
	"mindfs/server/internal/session"
)

func TestDetachSessionPreservesHistoryAndDescendants(t *testing.T) {
	ctx := context.Background()
	root := rootfs.NewRootInfo("mindfs", "mindfs", t.TempDir())
	m := session.NewManager(root)
	create := func(in session.CreateInput) *session.Session {
		t.Helper()
		in.Type = session.TypeChat
		s, err := m.Create(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	parent := create(session.CreateInput{Name: "parent"})
	source := `{"type":"fork","session_key":"original","seq":2}`
	child := create(session.CreateInput{Name: "child", ParentSessionKey: parent.Key, ParentToolCallID: "tool-call", Source: source, Agent: "codex"})
	grandchild := create(session.CreateInput{Name: "grandchild", ParentSessionKey: child.Key})
	sibling := create(session.CreateInput{Name: "sibling", ParentSessionKey: parent.Key})
	if err := m.AddExchangeForAgent(ctx, child, "user", "retained message", "codex", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateAgentState(ctx, child, "codex", 1, "native-session"); err != nil {
		t.Fatal(err)
	}
	service := Service{Registry: &commandTestRegistry{root: root, manager: m}}
	detached, err := service.DetachSession(ctx, DetachSessionInput{RootID: root.ID, Key: child.Key})
	if err != nil {
		t.Fatal(err)
	}
	if detached.Key != child.Key || detached.Name != "child" || detached.ParentSessionKey != "" || detached.ParentToolCallID != "" || detached.Source != source || len(detached.Exchanges) != 1 {
		t.Fatalf("incorrect detached session: %+v", detached)
	}
	again, err := service.DetachSession(ctx, DetachSessionInput{RootID: root.ID, Key: child.Key})
	if err != nil || !again.UpdatedAt.Equal(detached.UpdatedAt) {
		t.Fatalf("detach should be idempotent: %v", err)
	}
	// A later metadata write must not restore the old parent from the manager cache.
	if _, err := m.Rename(ctx, child.Key, "independent"); err != nil {
		t.Fatal(err)
	}
	loaded := session.NewManager(root)
	kept, err := loaded.Get(ctx, child.Key, 0)
	if err != nil || kept.ParentSessionKey != "" || kept.ParentToolCallID != "" || len(kept.Exchanges) != 1 || kept.Exchanges[0].Content != "retained message" {
		t.Fatalf("detach not persisted: %+v %v", kept, err)
	}
	binding, err := loaded.FindAgentBinding(ctx, child.Key, "codex")
	if err != nil || binding == nil || binding.AgentSessionID != "native-session" {
		t.Fatalf("agent binding changed: %+v %v", binding, err)
	}
	if err := service.DeleteSession(ctx, DeleteSessionInput{RootID: root.ID, Key: parent.Key}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Get(ctx, sibling.Key, 0); err == nil {
		t.Fatal("sibling should still belong to the deleted parent")
	}
	if _, err := m.Get(ctx, child.Key, 0); err != nil {
		t.Fatal("detached child deleted with original parent", err)
	}
	nested, err := m.Get(ctx, grandchild.Key, 0)
	if err != nil || nested.ParentSessionKey != child.Key {
		t.Fatalf("descendant hierarchy changed: %+v %v", nested, err)
	}
	if _, err := service.DetachSession(ctx, DetachSessionInput{RootID: root.ID, Key: "missing"}); err == nil {
		t.Fatal("missing session accepted")
	}
}
