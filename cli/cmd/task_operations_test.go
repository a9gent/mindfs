package main

import (
	"flag"
	"io"
	"strings"
	"testing"
)

func TestReadTaskJSON(t *testing.T) {
	for _, tc := range []struct {
		name, input                      string
		interactive, required, wantError bool
	}{
		{name: "heredoc", input: "{\n\"input\":\"hello\\nworld\"\n}", required: true},
		{name: "empty optional"},
		{name: "whitespace optional", input: " \n"},
		{name: "empty required", required: true, wantError: true},
		{name: "interactive required", interactive: true, required: true, wantError: true},
		{name: "interactive optional", interactive: true},
		{name: "null", input: "null", wantError: true},
		{name: "array", input: "[]", wantError: true},
		{name: "multiple objects", input: "{} {}", wantError: true},
		{name: "invalid JSON", input: "{", wantError: true},
		{name: "oversized", input: strings.Repeat(" ", (4<<20)+1), wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			var err error
			if tc.interactive {
				body, err = readTaskJSON(noReadInput{t}, true, tc.required)
			} else {
				body, err = readTaskJSON(strings.NewReader(tc.input), false, tc.required)
			}
			if (err != nil) != tc.wantError {
				t.Fatalf("error=%v", err)
			}
			if err == nil && body == nil {
				t.Fatal("nil object")
			}
			if tc.name == "heredoc" && body["input"] != "hello\nworld" {
				t.Fatalf("multiline content lost: %v", body)
			}
		})
	}
}

type noReadInput struct{ t *testing.T }

func (r noReadInput) Read([]byte) (int, error) {
	r.t.Fatal("interactive stdin must not be read")
	return 0, nil
}

func TestDirectTaskOperationFlags(t *testing.T) {
	for _, tc := range []struct {
		name       string
		args       []string
		scope      bool
		want       string
		count      int
		parseError bool
	}{
		{"graph", []string{"-graph"}, true, "graph", 1, false},
		{"plan", []string{"-plan"}, true, "plan", 1, false},
		{"task update", []string{"-update"}, true, "update", 1, false},
		{"service update", []string{"-update"}, false, "", 0, false},
		{"task status", []string{"-status"}, true, "status", 1, false},
		{"service status", []string{"-status"}, false, "", 0, false},
		{"next", []string{"-next"}, true, "next", 1, false},
		{"default", nil, true, "", 0, false},
		{"conflict", []string{"-publish", "-cancel"}, true, "", 2, false},
		{"status conflict", []string{"-status", "-next"}, true, "", 2, false},
		{"old syntax removed", []string{"-action", "graph"}, true, "", 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fs := flag.NewFlagSet("test", flag.ContinueOnError)
			fs.SetOutput(io.Discard)
			status := fs.Bool("status", false, "")
			update := fs.Bool("update", false, "")
			operations := registerTaskOperationFlags(fs, status, update)
			err := fs.Parse(tc.args)
			if (err != nil) != tc.parseError {
				t.Fatalf("parse error=%v", err)
			}
			if err != nil {
				return
			}
			action, count := selectedTaskOperation(operations, tc.scope)
			if count != tc.count || (count < 2 && action != tc.want) {
				t.Fatalf("action=%s count=%d", action, count)
			}
		})
	}
}
