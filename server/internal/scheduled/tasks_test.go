package scheduled

import (
	"context"
	"testing"
	"time"

	"mindfs/server/internal/api/usecase"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/session"
)

type testRegistry struct {
	usecase.Registry
	root    fs.RootInfo
	manager *session.Manager
}

type testBroadcaster struct {
	SessionActivityBroadcaster
	failedSession string
}

func (b *testBroadcaster) BroadcastScheduledTaskFailed(_, _, _, key, _ string) {
	b.failedSession = key
}

func (r *testRegistry) GetRoot(string) (fs.RootInfo, error)                { return r.root, nil }
func (r *testRegistry) GetSessionManager(string) (*session.Manager, error) { return r.manager, nil }

func TestFixedSessionTaskSaveAndReload(t *testing.T) {
	ctx := context.Background()
	root := fs.NewRootInfo("root", "Root", t.TempDir())
	manager := session.NewManager(root)
	sess, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, Agent: "codex", Name: "Existing chat"})
	if err != nil {
		t.Fatal(err)
	}
	broadcaster := &testBroadcaster{}
	svc := NewService(&testRegistry{root: root, manager: manager}, broadcaster)
	in := SaveInput{RootID: root.ID, Name: "Reminder", Enabled: true, TaskCron: "0 9 * * *", Agent: "codex", Prompt: "Check status", FixedSessionKey: sess.Key}
	task, err := svc.Create(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	if task.SessionKey != sess.Key || task.FixedSessionKey != sess.Key {
		t.Fatalf("binding lost: %+v", task)
	}
	in.ID = task.ID
	in.Prompt = "Updated prompt"
	if _, err := svc.Update(ctx, in); err != nil {
		t.Fatal(err)
	}
	// A client that omits the new field must preserve the saved binding.
	in.FixedSessionKey = ""
	if _, err := svc.Update(ctx, in); err != nil {
		t.Fatal(err)
	}
	tasks, err := svc.List(ctx, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].FixedSessionKey != sess.Key || tasks[0].Prompt != in.Prompt {
		t.Fatalf("unexpected saved tasks: %+v", tasks)
	}
	in.FixedSessionKey = sess.Key
	in.NewSessionCron = "* * * * *"
	if _, err := svc.Update(ctx, in); err == nil {
		t.Fatal("accepted new session schedule for a fixed session")
	}
	in.NewSessionCron = ""
	in.FixedSessionKey = "missing-session"
	if _, err := svc.Create(ctx, in); err == nil {
		t.Fatal("accepted missing fixed session")
	}
	if err := manager.Delete(ctx, sess.Key); err != nil {
		t.Fatal(err)
	}
	result, err := svc.RunNow(ctx, root.ID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.LastError == "" || result.SessionKey != sess.Key || broadcaster.failedSession != sess.Key {
		t.Fatalf("deleted fixed session should fail without replacement: %+v", result)
	}
}

func TestFixedSessionNeverResets(t *testing.T) {
	svc := NewService(nil, nil)
	task := Task{TaskCron: "0 9 * * *", NewSessionCron: "* * * * *"}
	if !svc.shouldCreateNewSession(task, time.Now()) {
		t.Fatal("ordinary task should start a new session")
	}
	task.FixedSessionKey = "existing-session"
	if svc.shouldCreateNewSession(task, time.Now()) {
		t.Fatal("fixed session must not reset")
	}
	svc.decorateTask(&task)
	if task.NextNewSessionAt != nil {
		t.Fatal("fixed session must not advertise a reset")
	}
}
