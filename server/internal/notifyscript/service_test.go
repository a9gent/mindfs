package notifyscript

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"mindfs/server/internal/notify"
)

func TestNotifyPayloadPassesJSONOnStdin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test is unix-only")
	}
	dir := t.TempDir()
	outPath := filepath.Join(dir, "payload.json")
	scriptPath := filepath.Join(dir, "notify.sh")
	script := "#!/bin/sh\ncat > '" + strings.ReplaceAll(outPath, "'", "'\\''") + "'\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}
	service := NewService(Config{Script: scriptPath, Timeout: time.Second})
	service.NotifyPayload(context.Background(), notify.Payload{
		Type:  "session.done",
		Title: "MindFS",
		Data:  map[string]any{"eventId": "event-1"},
	})

	deadline := time.Now().Add(2 * time.Second)
	for {
		b, err := os.ReadFile(outPath)
		if err == nil && strings.Contains(string(b), `"type":"session.done"`) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("payload was not written, last read err=%v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestCommandSpecForWindowsScripts(t *testing.T) {
	tests := []struct {
		script string
		name   string
		args   []string
	}{
		{script: `C:\hooks\notify.cmd`, name: "cmd.exe", args: []string{"/C", `C:\hooks\notify.cmd`}},
		{script: `C:\hooks\notify.bat`, name: "cmd.exe", args: []string{"/C", `C:\hooks\notify.bat`}},
		{script: `C:\hooks\notify.ps1`, name: "powershell.exe", args: []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `C:\hooks\notify.ps1`}},
		{script: `C:\hooks\notify.exe`, name: `C:\hooks\notify.exe`, args: nil},
	}
	for _, tt := range tests {
		name, args := commandSpecForScript("windows", tt.script)
		if name != tt.name || strings.Join(args, "\x00") != strings.Join(tt.args, "\x00") {
			t.Fatalf("commandSpecForScript(%q) = %q %#v, want %q %#v", tt.script, name, args, tt.name, tt.args)
		}
	}
}
