package commandexec

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

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

func TestLongShellBootstrapDisablesUserHistory(t *testing.T) {
	tests := []struct {
		shell string
		want  []string
	}{
		{shell: "zsh", want: []string{"unset HISTFILE", "SAVEHIST=0", "HIST_NO_STORE"}},
		{shell: "bash", want: []string{"HISTFILE=/dev/null", "set +o history", "history -c"}},
		{shell: "fish", want: []string{"set -g fish_history ''", "function fish_prompt; end"}},
	}
	for _, tt := range tests {
		t.Run(tt.shell, func(t *testing.T) {
			bootstrap := longShellBootstrap(tt.shell)
			for _, want := range tt.want {
				if !strings.Contains(bootstrap, want) {
					t.Fatalf("bootstrap for %s does not contain %q: %q", tt.shell, want, bootstrap)
				}
			}
		})
	}
}

func TestLongShellBootstrapDisablesPowerShellHistory(t *testing.T) {
	bootstrap := longShellBootstrapForOS("pwsh", "windows")
	for _, want := range []string{"Set-PSReadLineOption", "HistorySaveStyle SaveNothing", "Clear-History"} {
		if !strings.Contains(bootstrap, want) {
			t.Fatalf("PowerShell bootstrap does not contain %q: %q", want, bootstrap)
		}
	}
}

func TestLongShellEnvOverridesHistoryFile(t *testing.T) {
	env := longShellEnv([]string{"HISTFILE=/tmp/user-history"}, "zsh")
	if got := lastEnvValue(env, "HISTFILE"); got != "/dev/null" {
		t.Fatalf("HISTFILE = %q, want /dev/null", got)
	}
	if got := lastEnvValue(env, "SAVEHIST"); got != "0" {
		t.Fatalf("SAVEHIST = %q, want 0", got)
	}
}

func lastEnvValue(env []string, key string) string {
	prefix := key + "="
	value := ""
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			value = strings.TrimPrefix(item, prefix)
		}
	}
	return value
}

func TestLongShellDoesNotFeedControlScriptToCommandStdin(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available")
	}
	dir := t.TempDir()
	sessionKey := "stdin-" + strings.ReplaceAll(t.Name(), "/", "-")
	defer CloseSession("root", sessionKey)

	proc, err := StartInSession(context.Background(), Options{
		Command: "cat > consumed.txt",
		Cwd:     dir,
		Shells:  []ShellSpec{{Command: "sh"}},
		RootID:  "root",
		Session: sessionKey,
	})
	if err != nil {
		t.Fatalf("StartInSession returned error: %v", err)
	}

	done := make(chan Result, 1)
	go func() {
		done <- proc.Wait()
	}()

	select {
	case result := <-done:
		if result.ExitCode != 0 {
			t.Fatalf("exit code = %d, want 0", result.ExitCode)
		}
	case <-time.After(3 * time.Second):
		_ = proc.KillTree()
		t.Fatal("command did not finish; control script may have been exposed on stdin")
	}

	data, err := os.ReadFile(filepath.Join(dir, "consumed.txt"))
	if err != nil {
		t.Fatalf("read consumed.txt: %v", err)
	}
	if len(data) != 0 {
		t.Fatalf("consumed.txt = %q, want empty", string(data))
	}
}

func TestLongShellEvalKeepsShellState(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available")
	}
	dir := t.TempDir()
	subdir := filepath.Join(dir, "subdir")
	if err := os.Mkdir(subdir, 0o755); err != nil {
		t.Fatalf("mkdir subdir: %v", err)
	}
	sessionKey := "state-" + strings.ReplaceAll(t.Name(), "/", "-")
	defer CloseSession("root", sessionKey)

	first, err := StartInSession(context.Background(), Options{
		Command: "cd subdir",
		Cwd:     dir,
		Shells:  []ShellSpec{{Command: "sh"}},
		RootID:  "root",
		Session: sessionKey,
	})
	if err != nil {
		t.Fatalf("first StartInSession returned error: %v", err)
	}
	if result := waitForTestCommand(t, first); result.ExitCode != 0 {
		t.Fatalf("first exit code = %d, want 0", result.ExitCode)
	}

	second, err := StartInSession(context.Background(), Options{
		Command: "pwd",
		Cwd:     dir,
		Shells:  []ShellSpec{{Command: "sh"}},
		RootID:  "root",
		Session: sessionKey,
	})
	if err != nil {
		t.Fatalf("second StartInSession returned error: %v", err)
	}
	output := readTestOutput(second.Output())
	if result := waitForTestCommand(t, second); result.ExitCode != 0 {
		t.Fatalf("second exit code = %d, want 0", result.ExitCode)
	}
	gotPath, err := filepath.EvalSymlinks(strings.TrimSpace(output))
	if err != nil {
		t.Fatalf("eval pwd path: %v", err)
	}
	wantPath, err := filepath.EvalSymlinks(subdir)
	if err != nil {
		t.Fatalf("eval subdir path: %v", err)
	}
	if gotPath != wantPath {
		t.Fatalf("pwd = %q, want %q", gotPath, wantPath)
	}
}

func waitForTestCommand(t *testing.T, proc Process) Result {
	t.Helper()
	done := make(chan Result, 1)
	go func() {
		done <- proc.Wait()
	}()
	select {
	case result := <-done:
		return result
	case <-time.After(3 * time.Second):
		_ = proc.KillTree()
		t.Fatal("command did not finish")
	}
	return Result{ExitCode: -1}
}

func readTestOutput(output <-chan []byte) string {
	var out strings.Builder
	for chunk := range output {
		out.Write(chunk)
	}
	return out.String()
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

	if got := findMarkerLine("C:\\Users\\me>"+start+"\r\n", start); got < 0 {
		t.Fatalf("start marker with prompt prefix was not found")
	}
	if got := findMarkerLinePrefix("C:\\Users\\me>"+end+"0\r\n", end); got < 0 {
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
