package kanban

import (
	"context"
	"testing"
	"time"
)

func TestGroupMessageHistoryIncludesHandledAndCompletedMessages(t *testing.T) {
	ctx := context.Background()
	s, store, g := groupFixture(t)
	defer s.Close()
	task := groupTask(t, s, g, "communication")
	now := time.Now().UTC()
	events := []TaskEvent{
		{ID: "report", TaskID: task.Task.ID, ReceiverTaskID: g.ID, Type: "from-task", Payload: `{"message":"question"}`, HandledAt: now.Format(time.RFC3339Nano)},
		{ID: "reply", TaskID: g.ID, ReceiverTaskID: task.Task.ID, Type: "to-task", Payload: `{"message":"answer"}`, HandledAt: now.Format(time.RFC3339Nano)},
		{ID: "delivery", TaskID: task.Task.ID, Type: "from-task", Payload: `{"message":"done","completed":true,"execution_id":"internal"}`},
		{ID: "pending", TaskID: task.Task.ID, ReceiverTaskID: g.ID, Type: "from-task", Payload: `{"message":"new question"}`},
		{ID: "failure", TaskID: task.Task.ID, ReceiverTaskID: g.ID, Type: "execution_fail", Payload: `{"message":"execution failed"}`},
		{ID: "internal", TaskID: g.ID, Type: "acceptance_ready", Payload: `{"message":"review"}`},
		{ID: "other", TaskID: "other-task", ReceiverTaskID: "other-group", Type: "from-task", Payload: `{"message":"unrelated"}`},
	}
	for i, event := range events {
		event.CreatedAt = now.Add(time.Duration(i) * time.Second)
		if err := store.AddEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	graph, err := s.GroupGraph(ctx, g.RootID, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(graph.MessageHistory) != 5 || len(graph.Messages) != 2 {
		t.Fatalf("history or pending inbox incorrect: %+v", graph)
	}
	for i, text := range []string{"question", "answer", "done", "new question", "execution failed"} {
		message := graph.MessageHistory[i]
		from, to := task.Task.ID, g.SessionKey
		if i == 1 {
			from, to = to, from
		}
		if message.From != from || message.To != to || message.Message != text || !message.Timestamp.Equal(now.Add(time.Duration(i)*time.Second)) {
			t.Fatalf("incorrect message %d: %+v", i, message)
		}
	}
}
