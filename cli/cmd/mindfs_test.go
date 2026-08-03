package main

import (
	"reflect"
	"testing"
)

func TestNormalizeTaskRootFirstArgs(t *testing.T) {
	got := normalizeTaskRootFirstArgs([]string{"mindfs", "-task", "12", "-next"})
	want := []string{"-task", "12", "-next", "mindfs"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %#v, want %#v", got, want)
	}
}

func TestTaskCLIActionDefaultsToStatus(t *testing.T) {
	if got := taskCLIAction(false, false, false); got != "status" {
		t.Fatalf("action = %q, want status", got)
	}
	if got := taskCLIAction(false, true, true); got != "" {
		t.Fatalf("conflicting action = %q, want empty", got)
	}
}
