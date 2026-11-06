package codex

import (
	"context"
	"os"
	"testing"
	"time"

	codexsdk "github.com/fanwenlin/codex-go-sdk/codex"
)

// Starts empty threads in an isolated Codex home; never starts a model turn.
func TestSessionCloseLive(t *testing.T) {
	if os.Getenv("MINDFS_TEST_CODEX_CLOSE") != "1" {
		t.Skip("set MINDFS_TEST_CODEX_CLOSE=1 to test the installed app server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client := newClient(OpenOptions{
		Command: "codex",
		Args:    []string{"-c", "thread_unload_delay_secs=1800"},
		Env:     map[string]string{"CODEX_HOME": t.TempDir()},
	})
	defer client.Close()
	start := func() string {
		t.Helper()
		var response struct {
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
		}
		if err := client.AppServerRPCTyped(ctx, "thread/start", map[string]any{"cwd": t.TempDir()}, &response); err != nil {
			t.Fatal(err)
		}
		if response.Thread.ID == "" {
			t.Fatal("thread/start returned no ID")
		}
		return response.Thread.ID
	}
	id, otherID := start(), start()
	s := &session{client: client, thread: client.ResumeThread(id, codexsdk.ThreadOptions{}), threadID: id}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	var loaded struct {
		Data []string `json:"data"`
	}
	if err := client.AppServerRPCTyped(ctx, "thread/loaded/list", map[string]any{}, &loaded); err != nil {
		t.Fatal(err)
	}
	otherLoaded := false
	for _, threadID := range loaded.Data {
		if threadID == id {
			t.Fatalf("Close returned success but thread %s is still loaded", id)
		}
		otherLoaded = otherLoaded || threadID == otherID
	}
	if !otherLoaded {
		t.Fatal("closing one thread unloaded the other subscribed thread")
	}
	if err := s.Close(); err != nil {
		t.Fatalf("close already unloaded thread: %v", err)
	}
}
