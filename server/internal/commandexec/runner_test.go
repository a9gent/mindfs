package commandexec

import "testing"

func TestShellCommandUsesConfiguredShellOrder(t *testing.T) {
	fallback := DefaultShell()
	shell, _, err := shellCommand("echo ok", []ShellSpec{{Command: "definitely-not-a-mindfs-shell"}, {Command: fallback}})
	if err != nil {
		t.Fatalf("shellCommand returned error: %v", err)
	}
	if shell != fallback {
		t.Fatalf("shell = %q, want %q", shell, fallback)
	}
}

func TestShellCommandFailsWhenConfiguredShellsAreUnavailable(t *testing.T) {
	_, _, err := shellCommand("echo ok", []ShellSpec{{Command: "definitely-not-a-mindfs-shell"}})
	if err == nil {
		t.Fatalf("shellCommand returned nil error")
	}
}

func TestShellCommandUsesConfiguredArgs(t *testing.T) {
	fallback := DefaultShell()
	shell, args, err := shellCommand("echo ok", []ShellSpec{{Command: fallback, Args: []string{"-custom"}}})
	if err != nil {
		t.Fatalf("shellCommand returned error: %v", err)
	}
	if shell != fallback {
		t.Fatalf("shell = %q, want %q", shell, fallback)
	}
	if len(args) != 2 || args[0] != "-custom" || args[1] != "echo ok" {
		t.Fatalf("args = %#v, want configured args plus command", args)
	}
}

func TestShellCommandUsesConfiguredCommandPrefix(t *testing.T) {
	fallback := DefaultShell()
	_, args, err := shellCommand("echo ok", []ShellSpec{{Command: fallback, Args: []string{"-custom"}, CommandPrefix: "prefix;"}})
	if err != nil {
		t.Fatalf("shellCommand returned error: %v", err)
	}
	if len(args) != 2 || args[1] != "prefix; echo ok" {
		t.Fatalf("args = %#v, want command prefix plus command", args)
	}
}

func TestCloseSessionRemovesAllShellsForRootSession(t *testing.T) {
	manager := &longShellManager{sessions: map[string]*longShellSession{
		longShellKey("root", "session", "zsh"):       {},
		longShellKey("root", "session", "bash"):      {},
		longShellKey("root", "other-session", "zsh"): {},
		longShellKey("other-root", "session", "zsh"): {},
	}}

	manager.closeSession("root", "session")

	if _, ok := manager.sessions[longShellKey("root", "session", "zsh")]; ok {
		t.Fatalf("zsh shell for deleted session was not removed")
	}
	if _, ok := manager.sessions[longShellKey("root", "session", "bash")]; ok {
		t.Fatalf("bash shell for deleted session was not removed")
	}
	if _, ok := manager.sessions[longShellKey("root", "other-session", "zsh")]; !ok {
		t.Fatalf("other session shell should remain")
	}
	if _, ok := manager.sessions[longShellKey("other-root", "session", "zsh")]; !ok {
		t.Fatalf("other root shell should remain")
	}
}

func TestStripShellControlEchoSuppressesSplitPowerShellLine(t *testing.T) {
	run := &longShellCommand{}

	if got := run.stripShellControlEchoLocked("ok\nPS C:\\Users\\me> $__mindfs_status = if ($global:LASTEXITCODE"); got != "ok\n" {
		t.Fatalf("first chunk = %q, want ok line only", got)
	}
	if got := run.stripShellControlEchoLocked(" -ne $null) { 0 } else { 1 }\nnext\n"); got != "next\n" {
		t.Fatalf("second chunk = %q, want next line only", got)
	}
}

func TestStripShellControlEchoSuppressesPowerShellWriteOutputEcho(t *testing.T) {
	run := &longShellCommand{}
	end := "__MINDFS_CMD_END_abc__:"

	value := "real output\r\n" +
		"PS C:\\Users\\me> Write-Output ('" + end + "' + $__mindfs_status)\r\n" +
		"next\r\n"
	if got := run.stripShellControlEchoLocked(value); got != "real output\r\nnext\r\n" {
		t.Fatalf("output = %q, want control Write-Output echo removed", got)
	}
}

func TestStripShellControlEchoSuppressesWrappedPowerShellWriteOutputEcho(t *testing.T) {
	run := &longShellCommand{}

	if got := run.stripShellControlEchoLocked("PS C:\\Users\\me> Write-Outpu\r\n"); got != "" {
		t.Fatalf("wrapped first line = %q, want removed", got)
	}
	if got := run.stripShellControlEchoLocked("t ('__MINDFS_CMD_END_abc__:' + $__mindfs_status)\r\nnext\r\n"); got != "next\r\n" {
		t.Fatalf("wrapped second line = %q, want only next line", got)
	}
}

func TestSplitCompleteLinesForEmitWaitsForPowerShellEchoLine(t *testing.T) {
	endPrefix := "__MINDFS_CMD_END_abc__:"
	pending := "file.txt\nPS C:\\Users\\me> $__mindfs_status"
	emit, rest := splitCompleteLinesForEmit(pending, len(endPrefix)+16)

	if emit != "file.txt\n" {
		t.Fatalf("emit = %q, want completed output line only", emit)
	}
	if rest != "PS C:\\Users\\me> $__mindfs_status" {
		t.Fatalf("rest = %q, want partial PowerShell echo retained", rest)
	}
}

func TestFindMarkersAllowsWindowsPromptPrefix(t *testing.T) {
	start := "__MINDFS_CMD_START_abc__"
	end := "__MINDFS_CMD_END_abc__:"

	if got := findMarkerLine("C:\\Users\\me>" + start + "\r\n", start); got < 0 {
		t.Fatalf("start marker with prompt prefix was not found")
	}
	if got := findMarkerLinePrefix("C:\\Users\\me>" + end + "0\r\n", end); got < 0 {
		t.Fatalf("end marker with prompt prefix was not found")
	}
}

func TestFindStartMarkerIgnoresPowerShellEcho(t *testing.T) {
	start := "__MINDFS_CMD_START_abc__"
	value := "PS C:\\Users\\me> Write-Output '" + start + "'\r\n" +
		start + "\r\n" +
		"PS C:\\Users\\me> pwd\r\n"

	idx := findMarkerLine(value, start)
	if idx < 0 {
		t.Fatalf("actual start marker was not found")
	}
	if value[idx-1] == '\'' || value[idx+len(start)] == '\'' {
		t.Fatalf("idx points to echoed marker, want actual marker")
	}
}

func TestFindEndMarkerWithExitCodeIgnoresPowerShellEcho(t *testing.T) {
	end := "__MINDFS_CMD_END_abc__:"
	value := "PS C:\\Users\\me> Write-Output ('" + end + "' + $__mindfs_status)\r\n" +
		"real output\r\n" +
		end + "127\r\n"

	idx, code, ok := findEndMarkerWithExitCode(value, end)
	if !ok {
		t.Fatalf("end marker with numeric exit code was not found")
	}
	if code != "127" {
		t.Fatalf("code = %q, want 127", code)
	}
	if value[idx-2:idx] != "\r\n" {
		t.Fatalf("idx points to echoed marker, want actual marker")
	}
}

func TestTakeExitCodeRejectsPowerShellExpression(t *testing.T) {
	if code, ok := takeExitCode("' + $__mindfs_status)\r\n"); ok {
		t.Fatalf("takeExitCode accepted expression with code %q", code)
	}
}

func TestStripShellControlEchoKeepsNormalOutput(t *testing.T) {
	run := &longShellCommand{}

	got := run.stripShellControlEchoLocked("Mode Name\n-a--- file.txt\n")
	if got != "Mode Name\n-a--- file.txt\n" {
		t.Fatalf("output = %q", got)
	}
}
