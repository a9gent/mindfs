package commandexec

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type longShellManager struct {
	mu       sync.Mutex
	sessions map[string]*longShellSession
}

type longShellSession struct {
	key   string
	shell string
	proc  Process

	mu      sync.Mutex
	current *longShellCommand
	closed  bool
}

type longShellCommand struct {
	session *longShellSession
	id      string
	started time.Time
	out     chan []byte
	done    chan Result

	startMarker string
	endPrefix   string

	mu            sync.Mutex
	startedOutput bool
	pending       string
	finished      bool
	suppressEcho  bool
}

var defaultLongShells = &longShellManager{sessions: make(map[string]*longShellSession)}

const maxPendingLineBytes = 64 * 1024

func StartInSession(ctx context.Context, opts Options) (Process, error) {
	rootID := strings.TrimSpace(opts.RootID)
	sessionKey := strings.TrimSpace(opts.Session)
	if rootID == "" || sessionKey == "" {
		return Start(ctx, opts)
	}
	return defaultLongShells.start(ctx, longShellKey(rootID, sessionKey, opts.Shell), opts)
}

func CloseSession(rootID, sessionKey string) {
	rootID = strings.TrimSpace(rootID)
	sessionKey = strings.TrimSpace(sessionKey)
	if rootID == "" || sessionKey == "" {
		return
	}
	defaultLongShells.closeSession(rootID, sessionKey)
}

func longShellKey(rootID, sessionKey, shell string) string {
	return strings.TrimSpace(rootID) + "::" + strings.TrimSpace(sessionKey) + "::" + strings.TrimSpace(shell)
}

func longShellSessionPrefix(rootID, sessionKey string) string {
	return strings.TrimSpace(rootID) + "::" + strings.TrimSpace(sessionKey) + "::"
}

func (m *longShellManager) start(ctx context.Context, key string, opts Options) (Process, error) {
	command := strings.TrimSpace(opts.Command)
	if command == "" {
		return nil, errors.New("command required")
	}
	sess, err := m.getOrCreate(ctx, key, opts)
	if err != nil {
		return nil, err
	}
	return sess.run(ctx, command)
}

func (m *longShellManager) closeSession(rootID, sessionKey string) {
	prefix := longShellSessionPrefix(rootID, sessionKey)
	var sessions []*longShellSession
	m.mu.Lock()
	for key, sess := range m.sessions {
		if strings.HasPrefix(key, prefix) {
			sessions = append(sessions, sess)
			delete(m.sessions, key)
		}
	}
	m.mu.Unlock()
	for _, sess := range sessions {
		_ = sess.killShell()
	}
}

func (m *longShellManager) getOrCreate(ctx context.Context, key string, opts Options) (*longShellSession, error) {
	m.mu.Lock()
	if existing := m.sessions[key]; existing != nil && !existing.isClosed() {
		m.mu.Unlock()
		if err := existing.resize(opts.TerminalCols); err == nil && opts.TerminalCols > 0 {
			time.Sleep(25 * time.Millisecond)
		}
		return existing, nil
	}
	delete(m.sessions, key)
	m.mu.Unlock()

	sess, err := newLongShellSession(ctx, key, opts)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if existing := m.sessions[key]; existing != nil && !existing.isClosed() {
		m.mu.Unlock()
		_ = sess.killShell()
		if err := existing.resize(opts.TerminalCols); err == nil && opts.TerminalCols > 0 {
			time.Sleep(25 * time.Millisecond)
		}
		return existing, nil
	}
	m.sessions[key] = sess
	m.mu.Unlock()
	return sess, nil
}

func newLongShellSession(_ context.Context, key string, opts Options) (*longShellSession, error) {
	cwd := strings.TrimSpace(opts.Cwd)
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return nil, err
		}
	}
	absCwd, err := filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}
	spec, ok := ResolveConfiguredShell(opts.Shells, opts.Shell)
	if !ok {
		if len(normalizeShells(opts.Shells)) > 0 {
			return nil, errors.New("no configured shell found")
		}
		spec = ShellSpec{Command: DefaultShell()}
	}
	shell, args := longShellProcessCommand(spec)
	if strings.TrimSpace(shell) == "" {
		return nil, errors.New("no configured shell found")
	}
	cmd := exec.CommandContext(context.Background(), shell, args...)
	cmd.Dir = absCwd
	cmd.Env = longShellEnv(opts.Env, shell)
	proc, err := startLongShellPlatformProcess(context.Background(), cmd, shell, opts.TerminalCols)
	if err != nil {
		return nil, err
	}
	sess := &longShellSession{
		key:   key,
		shell: shell,
		proc:  proc,
	}
	go sess.readLoop()
	go sess.waitLoop()
	if bootstrap := longShellBootstrap(shell); bootstrap != "" {
		_, _ = proc.WriteInput([]byte(bootstrap))
	}
	time.Sleep(100 * time.Millisecond)
	return sess, nil
}

func longShellEnv(extra []string, shell string) []string {
	env := commandEnv(extra)
	if runtime.GOOS == "windows" {
		return env
	}
	switch strings.ToLower(filepath.Base(shell)) {
	case "bash", "zsh", "sh":
		env = append(env, "HISTFILE=/dev/null", "HISTSIZE=0", "HISTFILESIZE=0", "SAVEHIST=0")
	case "fish":
		env = append(env, "fish_history=")
	}
	return env
}

func longShellBootstrap(shell string) string {
	return longShellBootstrapForOS(shell, runtime.GOOS)
}

func longShellBootstrapForOS(shell, goos string) string {
	base := strings.ToLower(filepath.Base(shell))
	if goos == "windows" {
		switch base {
		case "powershell.exe", "powershell", "pwsh.exe", "pwsh":
			return "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = [Console]::OutputEncoding; $OutputEncoding = [Console]::OutputEncoding\n" +
				"if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) { Set-PSReadLineOption -HistorySaveStyle SaveNothing -ErrorAction SilentlyContinue }\n" +
				"Clear-History -ErrorAction SilentlyContinue\n"
		case "cmd.exe", "cmd":
			return "prompt $S\r\nchcp 65001 >NUL\r\n"
		}
		return ""
	}
	switch base {
	case "fish":
		return "set -e fish_history 2>/dev/null\nset -g fish_history '' 2>/dev/null\nfunction fish_prompt; end\nfunction fish_right_prompt; end\nstty -echo 2>/dev/null\n"
	case "zsh":
		return "unset HISTFILE\nHISTSIZE=0\nSAVEHIST=0\nsetopt HIST_NO_STORE 2>/dev/null || true\nunsetopt INC_APPEND_HISTORY INC_APPEND_HISTORY_TIME SHARE_HISTORY APPEND_HISTORY EXTENDED_HISTORY 2>/dev/null || true\nunsetopt zle prompt_cr prompt_sp 2>/dev/null || true\nPROMPT=''\nRPROMPT=''\nPS1=''\nPROMPT_COMMAND=''\nstty -echo 2>/dev/null || true\n"
	case "bash":
		return "HISTFILE=/dev/null\nexport HISTFILE\nHISTSIZE=0\nHISTFILESIZE=0\nset +o history 2>/dev/null || true\nhistory -c 2>/dev/null || true\nPROMPT=''\nRPROMPT=''\nPS1=''\nPROMPT_COMMAND=''\nstty -echo 2>/dev/null || true\n"
	default:
		return "HISTFILE=/dev/null\nexport HISTFILE\nHISTSIZE=0\nHISTFILESIZE=0\nset +o history 2>/dev/null || true\nunsetopt zle prompt_cr prompt_sp 2>/dev/null || true\nPROMPT=''\nRPROMPT=''\nPS1=''\nPROMPT_COMMAND=''\nstty -echo 2>/dev/null || true\n"
	}
}

func longShellProcessCommand(spec ShellSpec) (string, []string) {
	shell := strings.TrimSpace(spec.Command)
	if spec.LongShellArgs != nil {
		return shell, append([]string(nil), spec.LongShellArgs...)
	}
	if runtime.GOOS == "windows" {
		return interactiveShellCommand(spec)
	}
	return shell, nil
}

func (s *longShellSession) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

func (s *longShellSession) resize(cols int) error {
	if s == nil || s.proc == nil {
		return nil
	}
	return s.proc.Resize(cols, defaultTerminalRows)
}

func (s *longShellSession) markClosed() {
	s.mu.Lock()
	s.closed = true
	current := s.current
	s.current = nil
	s.mu.Unlock()
	if current != nil {
		current.finish(Result{
			Shell:      s.shell,
			ExitCode:   -1,
			StartedAt:  current.started,
			FinishedAt: time.Now().UTC(),
			Err:        errors.New("shell exited"),
		})
	}
}

func (s *longShellSession) run(_ context.Context, command string) (*longShellCommand, error) {
	run := &longShellCommand{
		session:     s,
		id:          strconv.FormatInt(time.Now().UnixNano(), 36),
		started:     time.Now().UTC(),
		out:         make(chan []byte, 32),
		done:        make(chan Result, 1),
		startMarker: "__MINDFS_CMD_START__",
	}
	run.startMarker = "__MINDFS_CMD_START_" + run.id + "__"
	run.endPrefix = "__MINDFS_CMD_END_" + run.id + "__:"

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errors.New("shell exited")
	}
	if s.current != nil {
		s.mu.Unlock()
		return nil, errors.New("command already running in this session")
	}
	s.current = run
	s.mu.Unlock()

	if _, err := s.proc.WriteInput([]byte(shellRunScript(s.shell, command, run.startMarker, run.endPrefix))); err != nil {
		s.clearCurrent(run)
		return nil, err
	}
	return run, nil
}

func shellRunScript(shell, command, startMarker, endPrefix string) string {
	base := strings.ToLower(filepath.Base(shell))
	if runtime.GOOS == "windows" {
		switch base {
		case "powershell.exe", "powershell", "pwsh.exe", "pwsh":
			return fmt.Sprintf("Write-Output %s\n%s\n$__mindfs_status = if ($global:LASTEXITCODE -ne $null) { $global:LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n$global:LASTEXITCODE = $null\nWrite-Output (%s + $__mindfs_status)\n", powershellQuote(startMarker), command, powershellQuote(endPrefix))
		case "cmd.exe", "cmd":
			return fmt.Sprintf("echo %s\r\n%s\r\necho %s%%ERRORLEVEL%%\r\n", startMarker, command, endPrefix)
		}
	}
	if base == "fish" {
		return fmt.Sprintf("command printf '\\n%s\\n'\neval %s </dev/null\nset -l __mindfs_status $status\ncommand printf '\\n%s%%s\\n' $__mindfs_status\n", shellQuote(startMarker), shellQuote(command), shellQuote(endPrefix))
	}
	return fmt.Sprintf("command printf '\\n%%s\\n' %s\neval %s </dev/null\n__mindfs_status=$?\ncommand printf '\\n%%s%%s\\n' %s \"$__mindfs_status\"\n", shellQuote(startMarker), shellQuote(command), shellQuote(endPrefix))
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func powershellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func (s *longShellSession) readLoop() {
	for chunk := range s.proc.Output() {
		s.mu.Lock()
		current := s.current
		s.mu.Unlock()
		if current == nil {
			continue
		}
		current.consume(chunk)
	}
	s.markClosed()
}

func (s *longShellSession) waitLoop() {
	result := s.proc.Wait()
	s.markClosed()
	defaultLongShells.remove(s.key, s)
	if result.Err != nil {
		return
	}
}

func (m *longShellManager) remove(key string, sess *longShellSession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessions[key] == sess {
		delete(m.sessions, key)
	}
}

func (s *longShellSession) clearCurrent(run *longShellCommand) {
	s.mu.Lock()
	if s.current == run {
		s.current = nil
	}
	s.mu.Unlock()
}

func (s *longShellSession) killShell() error {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	if s.proc == nil {
		return nil
	}
	return s.proc.KillTree()
}

func (r *longShellCommand) Output() <-chan []byte {
	return r.out
}

func (r *longShellCommand) WriteInput(input []byte) (int, error) {
	if r == nil || r.session == nil || r.session.proc == nil {
		return 0, nil
	}
	return r.session.proc.WriteInput(input)
}

func (r *longShellCommand) Resize(cols, rows int) error {
	if r == nil || r.session == nil || r.session.proc == nil {
		return nil
	}
	return r.session.proc.Resize(cols, rows)
}

func (r *longShellCommand) Interrupt() error {
	if r == nil || r.session == nil || r.session.proc == nil {
		return nil
	}
	_, err := r.session.proc.WriteInput([]byte{0x03})
	return err
}

func (r *longShellCommand) Terminate() error {
	if r == nil || r.doneAlready() {
		return nil
	}
	if r.session == nil {
		return nil
	}
	return r.session.killShell()
}

func (r *longShellCommand) KillTree() error {
	return r.Terminate()
}

func (r *longShellCommand) Wait() Result {
	if r == nil {
		return Result{ExitCode: -1}
	}
	return <-r.done
}

func (r *longShellCommand) consume(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.finished {
		return
	}
	r.pending += string(chunk)
	for {
		if !r.startedOutput {
			idx := findMarkerLine(r.pending, r.startMarker)
			if idx < 0 {
				r.pending = keepTail(r.pending, len(r.startMarker))
				return
			}
			r.pending = r.pending[idx+len(r.startMarker):]
			r.pending = trimLeadingLineBreak(r.pending)
			r.startedOutput = true
		}
		endIdx, codeText, ok := findEndMarkerWithExitCode(r.pending, r.endPrefix)
		if endIdx >= 0 {
			before := r.stripShellControlEchoLocked(r.pending[:endIdx])
			if before != "" {
				r.emitLocked([]byte(before))
			}
			if !ok {
				return
			}
			exitCode, _ := strconv.Atoi(codeText)
			r.pending = ""
			r.finishLocked(Result{
				Shell:      r.session.shell,
				ExitCode:   exitCode,
				Duration:   time.Since(r.started),
				StartedAt:  r.started,
				FinishedAt: time.Now().UTC(),
			})
			return
		}
		keep := len(r.endPrefix) + 16
		if len(r.pending) <= keep {
			return
		}
		emit, pending := splitCompleteLinesForEmit(r.pending, keep)
		if emit == "" {
			return
		}
		r.pending = pending
		emit = r.stripShellControlEchoLocked(emit)
		if emit != "" {
			r.emitLocked([]byte(emit))
		}
	}
}

func (r *longShellCommand) emitLocked(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	select {
	case r.out <- append([]byte(nil), chunk...):
	default:
		r.out <- append([]byte(nil), chunk...)
	}
}

func (r *longShellCommand) finish(result Result) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.finishLocked(result)
}

func (r *longShellCommand) finishLocked(result Result) {
	if r.finished {
		return
	}
	r.finished = true
	if result.StartedAt.IsZero() {
		result.StartedAt = r.started
	}
	if result.FinishedAt.IsZero() {
		result.FinishedAt = time.Now().UTC()
	}
	if result.Duration == 0 {
		result.Duration = result.FinishedAt.Sub(result.StartedAt)
	}
	r.session.clearCurrent(r)
	close(r.out)
	r.done <- result
	close(r.done)
}

func (r *longShellCommand) doneAlready() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.finished
}

func keepTail(value string, max int) string {
	if max <= 0 || len(value) <= max {
		return value
	}
	return value[len(value)-max:]
}

func splitCompleteLinesForEmit(value string, keep int) (string, string) {
	if keep < 0 {
		keep = 0
	}
	if idx := strings.LastIndexAny(value, "\r\n"); idx >= 0 {
		return value[:idx+1], value[idx+1:]
	}
	cut := len(value) - keep
	if cut <= 0 || len(value) <= maxPendingLineBytes {
		return "", value
	}
	return value[:cut], value[cut:]
}

func trimLeadingLineBreak(value string) string {
	return strings.TrimLeft(value, "\r\n")
}

func (r *longShellCommand) stripShellControlEchoLocked(value string) string {
	if value == "" {
		return value
	}
	lines := splitLinesKeepingBreaks(value)
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		hasLineBreak := strings.HasSuffix(line, "\n")
		if isPowerShellControlEchoLine(line) {
			if !hasLineBreak {
				r.suppressEcho = true
			}
			continue
		}
		if r.suppressEcho {
			if hasLineBreak {
				r.suppressEcho = false
			}
			continue
		}
		if idx := shellControlEchoIndex(line); idx >= 0 {
			if idx > 0 {
				prefix := line[:idx]
				if !looksLikeShellPromptPrefix(prefix) {
					kept = append(kept, prefix)
				}
			}
			if !hasLineBreak {
				r.suppressEcho = true
			}
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "")
}

func isPowerShellControlEchoLine(line string) bool {
	text := strings.TrimSpace(strings.TrimRight(line, "\r\n"))
	if text == "" {
		return false
	}
	if strings.Contains(text, "[Console]::OutputEncoding") ||
		strings.Contains(text, "[Console]::InputEncoding") ||
		strings.Contains(text, "$__mindfs_status") ||
		strings.Contains(text, "$global:LASTEXITCODE") {
		return true
	}
	prompt := strings.LastIndex(text, ">")
	if prompt < 0 {
		return false
	}
	afterPrompt := strings.TrimSpace(text[prompt+1:])
	if afterPrompt == "" {
		return false
	}
	commandFragment := afterPrompt
	if cut := strings.IndexAny(commandFragment, " \t('\""); cut >= 0 {
		commandFragment = commandFragment[:cut]
	}
	return len(commandFragment) >= len("Write-") && strings.HasPrefix("Write-Output", commandFragment)
}

func looksLikeShellPromptPrefix(prefix string) bool {
	trimmed := strings.TrimSpace(prefix)
	return strings.HasSuffix(trimmed, ">") || strings.HasSuffix(trimmed, "$") || strings.HasSuffix(trimmed, "%")
}

func splitLinesKeepingBreaks(value string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(value); i++ {
		if value[i] != '\n' {
			continue
		}
		lines = append(lines, value[start:i+1])
		start = i + 1
	}
	if start < len(value) {
		lines = append(lines, value[start:])
	}
	return lines
}

func isShellControlEcho(line string) bool {
	return shellControlEchoIndex(line) >= 0
}

func shellControlEchoIndex(line string) int {
	text := strings.TrimSpace(strings.TrimRight(line, "\r\n"))
	if text == "" {
		return -1
	}
	tokens := []string{
		"__MINDFS_CMD_START_",
		"__MINDFS_CMD_END_",
		"__mindfs_status",
		"$global:LASTEXITCODE",
		"[Console]::OutputEncoding",
		"[Console]::InputEncoding",
	}
	best := -1
	for _, token := range tokens {
		if idx := strings.Index(line, token); idx >= 0 && (best < 0 || idx < best) {
			best = idx
		}
	}
	return best
}

func takeExitCode(value string) (string, bool) {
	value = strings.TrimLeft(value, " \t")
	end := strings.IndexAny(value, "\r\n")
	if end < 0 {
		return "", false
	}
	code := strings.TrimSpace(value[:end])
	if code == "" {
		return "", false
	}
	for _, ch := range code {
		if ch < '0' || ch > '9' {
			return "", false
		}
	}
	return code, true
}

func findMarkerLine(value, marker string) int {
	for offset := 0; offset < len(value); {
		idx := strings.Index(value[offset:], marker)
		if idx < 0 {
			return -1
		}
		idx += offset
		after := idx + len(marker)
		if after < len(value) && (value[after] == '\r' || value[after] == '\n') {
			return idx
		}
		offset = after
	}
	return -1
}

func findMarkerLinePrefix(value, marker string) int {
	return strings.Index(value, marker)
}

func findEndMarkerWithExitCode(value, marker string) (int, string, bool) {
	for offset := 0; offset < len(value); {
		idx := strings.Index(value[offset:], marker)
		if idx < 0 {
			return -1, "", false
		}
		idx += offset
		code, ok := takeExitCode(value[idx+len(marker):])
		if ok {
			return idx, code, true
		}
		offset = idx + len(marker)
	}
	return -1, "", false
}
