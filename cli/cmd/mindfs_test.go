package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestNormalizeTaskRootFirstArgs(t *testing.T) {
	got := normalizeTaskRootFirstArgs([]string{"mindfs", "-task", "12", "-next"})
	want := []string{"-task", "12", "-next", "mindfs"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %#v, want %#v", got, want)
	}
}

func TestNormalizeTaskGroupRootFirstArgs(t *testing.T) {
	for _, flag := range []string{"-to-task", "--to-task", "-to-task=id", "-from-task", "--from-task=id", "-task-group", "--task-group", "-task-group=id", "--task-group=id", "-task-groups", "--task-groups", "-task-group-create", "--task-group-create"} {
		args := []string{"root-id", flag}
		want := []string{flag, "root-id"}
		if got := normalizeTaskRootFirstArgs(args); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: got %v, want %v", flag, got, want)
		}
	}
	for _, flag := range []string{"-task-templates", "-agents", "-orchestration"} {
		args := []string{flag}
		if got := normalizeTaskRootFirstArgs(args); !reflect.DeepEqual(got, args) {
			t.Fatalf("global flag changed: %v", got)
		}
	}
}

func TestWaitForForegroundAppExitWaitsForCleanupAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	errCh := make(chan error, 1)
	want := errors.New("cleanup complete")
	done := make(chan error, 1)
	go func() {
		done <- waitForForegroundAppExit(ctx, errCh)
	}()

	select {
	case <-done:
		t.Fatal("returned before app cleanup completed")
	case <-time.After(20 * time.Millisecond):
	}
	errCh <- want
	select {
	case got := <-done:
		if !errors.Is(got, want) {
			t.Fatalf("wait error = %v, want %v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for app cleanup result")
	}
}

func TestRestoreDefaultSignalsAfterCancellationCallsStop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	restoreDefaultSignalsAfterCancellation(ctx, func() { close(stopped) })

	cancel()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("signal notifications were not stopped after cancellation")
	}
}
