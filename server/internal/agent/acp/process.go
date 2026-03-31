// Package acp provides ACP-based agent process implementation.
// All supported agents are accessed through ACP.
package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

// Process manages an agent process using ACP.
// This implementation works with any ACP-compatible agent:
// - claude (via claude-code-acp wrapper)
// - gemini (via --experimental-acp flag)
// - codex (via codex-acp wrapper)
type Process struct {
	agentName string
	cmd       *exec.Cmd
	conn      *acp.ClientSideConnection
	client    *mindfsClient
	waitCh    chan error

	mu           sync.RWMutex
	sessions     map[string]*sessionState // sessionKey -> state
	sessionsByID map[string]*sessionState // ACP session id -> state
	capability   CapabilitySnapshot
	models       *acp.SessionModelState
	commands     []acp.AvailableCommand
	stderrHint   stderrHintState
	activePrompt activePromptState
}

type CapabilitySnapshot struct {
	PromptSupportsAudio   bool
	PromptSupportsImage   bool
	PromptSupportsContext bool
}

type stderrHintState struct {
	mu            sync.Mutex
	expectMessage bool
	message       string
	messageAt     time.Time
}

type activePromptState struct {
	mu     sync.Mutex
	id     int64
	cancel context.CancelFunc
}

var stderrMessagePattern = regexp.MustCompile(`"message"\s*:\s*"([^"]+)"`)

type sessionState struct {
	ID       acp.SessionId
	models   *acp.SessionModelState
	commands []acp.AvailableCommand
	onUpdate func(SessionUpdate)
	mu       sync.RWMutex
}

type qwenSlashCommandNotification struct {
	SessionID   string `json:"sessionId"`
	Command     string `json:"command"`
	MessageType string `json:"messageType"`
	Message     string `json:"message"`
}

type sessionUpdateHandler func(SessionUpdate)

func (s *sessionState) setOnUpdate(onUpdate func(SessionUpdate)) {
	s.mu.Lock()
	s.onUpdate = onUpdate
	s.mu.Unlock()
}

func (s *sessionState) getOnUpdate() func(SessionUpdate) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.onUpdate
}

func (s *sessionState) setModels(models *acp.SessionModelState) {
	s.mu.Lock()
	s.models = models
	s.mu.Unlock()
}

func (s *sessionState) getModels() *acp.SessionModelState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.models
}

func (s *sessionState) setCommands(commands []acp.AvailableCommand) {
	s.mu.Lock()
	if len(commands) == 0 {
		s.commands = nil
	} else {
		s.commands = append([]acp.AvailableCommand(nil), commands...)
	}
	s.mu.Unlock()
}

func (s *sessionState) getCommands() []acp.AvailableCommand {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.commands) == 0 {
		return nil
	}
	return append([]acp.AvailableCommand(nil), s.commands...)
}

// SessionUpdate is the internal session update type.
type SessionUpdate struct {
	Type      UpdateType
	SessionID string
	Raw       acp.SessionUpdate
}

// UpdateType defines the type of session update.
type UpdateType string

const (
	UpdateTypeMessageChunk UpdateType = "message_chunk"
	UpdateTypeThoughtChunk UpdateType = "thought_chunk"
	UpdateTypeToolCall     UpdateType = "tool_call"
	UpdateTypeToolUpdate   UpdateType = "tool_update"
	UpdateTypeMessageDone  UpdateType = "message_done"
)

// mindfsClient implements acp.Client interface
type mindfsClient struct {
	proc *Process
}

func (p *Process) agentLabel() string {
	if p == nil || p.agentName == "" {
		return "unknown"
	}
	return p.agentName
}

func (p *Process) getSessionUpdateHandler(sessionID string) sessionUpdateHandler {
	session := p.getSessionByID(sessionID)
	if session == nil {
		return nil
	}
	return session.getOnUpdate()
}

func (c *mindfsClient) SessionUpdate(ctx context.Context, params acp.SessionNotification) error {
	session := c.proc.getSessionByID(string(params.SessionId))
	if session == nil {
		return nil
	}
	handler := session.getOnUpdate()
	if handler == nil {
		return nil
	}

	internalUpdate := wrapSessionUpdate(string(params.SessionId), params.Update)
	if params.Update.AvailableCommandsUpdate != nil {
		session.setCommands(params.Update.AvailableCommandsUpdate.AvailableCommands)
		c.proc.mu.Lock()
		c.proc.commands = append([]acp.AvailableCommand(nil), params.Update.AvailableCommandsUpdate.AvailableCommands...)
		c.proc.mu.Unlock()
	}

	if internalUpdate.Type != "" {
		handler(internalUpdate)
	} else {
		raw, _ := json.Marshal(params.Update)
		log.Printf("[agent/acp] unhandled raw=%s", string(raw))
	}
	return nil
}

func (c *mindfsClient) RequestPermission(ctx context.Context, params acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	// Emit a synthetic tool_call update for permission-gated operations so upper
	// layers can track tool execution and associate file paths immediately.
	if session := c.proc.getSessionByID(string(params.SessionId)); session != nil {
		if handler := session.getOnUpdate(); handler != nil {
			toolCall := &acp.SessionUpdateToolCall{
				Content:    params.ToolCall.Content,
				Locations:  params.ToolCall.Locations,
				RawInput:   params.ToolCall.RawInput,
				RawOutput:  params.ToolCall.RawOutput,
				Title:      "",
				ToolCallId: params.ToolCall.ToolCallId,
				Status:     acp.ToolCallStatusPending,
			}
			if params.ToolCall.Title != nil {
				toolCall.Title = *params.ToolCall.Title
			}
			if params.ToolCall.Kind != nil {
				toolCall.Kind = *params.ToolCall.Kind
			} else {
				toolCall.Kind = acp.ToolKindOther
			}
			if params.ToolCall.Status != nil {
				toolCall.Status = *params.ToolCall.Status
			}
			handler(SessionUpdate{
				Type:      UpdateTypeToolCall,
				SessionID: string(params.SessionId),
				Raw: acp.SessionUpdate{
					ToolCall: toolCall,
				},
			})
		}
	}
	// TODO: Forward to frontend for user approval
	// For now, auto-approve with first allow option
	for _, opt := range params.Options {
		if opt.Kind == acp.PermissionOptionKindAllowOnce || opt.Kind == acp.PermissionOptionKindAllowAlways {
			return acp.RequestPermissionResponse{
				Outcome: acp.RequestPermissionOutcome{
					Selected: &acp.RequestPermissionOutcomeSelected{
						OptionId: opt.OptionId,
					},
				},
			}, nil
		}
	}
	// Fallback to first option
	if len(params.Options) > 0 {
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{
				Selected: &acp.RequestPermissionOutcomeSelected{
					OptionId: params.Options[0].OptionId,
				},
			},
		}, nil
	}
	return acp.RequestPermissionResponse{
		Outcome: acp.RequestPermissionOutcome{
			Cancelled: &acp.RequestPermissionOutcomeCancelled{},
		},
	}, nil
}

func (c *mindfsClient) ReadTextFile(ctx context.Context, params acp.ReadTextFileRequest) (acp.ReadTextFileResponse, error) {
	// Agent handles file operations itself
	return acp.ReadTextFileResponse{Content: ""}, nil
}

func (c *mindfsClient) WriteTextFile(ctx context.Context, params acp.WriteTextFileRequest) (acp.WriteTextFileResponse, error) {
	return acp.WriteTextFileResponse{}, nil
}

func (c *mindfsClient) CreateTerminal(ctx context.Context, params acp.CreateTerminalRequest) (acp.CreateTerminalResponse, error) {
	return acp.CreateTerminalResponse{}, nil
}

func (c *mindfsClient) TerminalOutput(ctx context.Context, params acp.TerminalOutputRequest) (acp.TerminalOutputResponse, error) {
	return acp.TerminalOutputResponse{}, nil
}

func (c *mindfsClient) ReleaseTerminal(ctx context.Context, params acp.ReleaseTerminalRequest) (acp.ReleaseTerminalResponse, error) {
	return acp.ReleaseTerminalResponse{}, nil
}

func (c *mindfsClient) WaitForTerminalExit(ctx context.Context, params acp.WaitForTerminalExitRequest) (acp.WaitForTerminalExitResponse, error) {
	return acp.WaitForTerminalExitResponse{}, nil
}

func (c *mindfsClient) KillTerminalCommand(ctx context.Context, params acp.KillTerminalCommandRequest) (acp.KillTerminalCommandResponse, error) {
	return acp.KillTerminalCommandResponse{}, nil
}

func (c *mindfsClient) HandleExtensionMethod(_ context.Context, method string, params json.RawMessage) (any, error) {
	switch method {
	case "_qwencode/slash_command":
		return nil, c.handleQwenSlashCommandNotification(params)
	default:
		return nil, acp.NewMethodNotFound(method)
	}
}

func (c *mindfsClient) handleQwenSlashCommandNotification(params json.RawMessage) error {
	var notif qwenSlashCommandNotification
	if err := json.Unmarshal(params, &notif); err != nil {
		return acp.NewInvalidParams(map[string]any{"error": err.Error()})
	}
	if strings.TrimSpace(notif.SessionID) == "" {
		return acp.NewInvalidParams(map[string]any{"error": "sessionId required"})
	}
	handler := c.proc.getSessionUpdateHandler(notif.SessionID)
	if handler == nil {
		return nil
	}
	content := notif.Message
	if content == "" {
		return nil
	}
	log.Printf("[agent/acp] ext.notification agent=%s method=_qwencode/slash_command session_id=%s command=%q message_type=%s", c.proc.agentLabel(), notif.SessionID, notif.Command, notif.MessageType)
	handler(newMessageChunkUpdate(notif.SessionID, content, map[string]any{
		"source":       "_qwencode/slash_command",
		"command":      notif.Command,
		"message_type": notif.MessageType,
	}))
	return nil
}

func newMessageChunkUpdate(sessionID, content string, meta map[string]any) SessionUpdate {
	return SessionUpdate{
		Type:      UpdateTypeMessageChunk,
		SessionID: sessionID,
		Raw: acp.SessionUpdate{
			AgentMessageChunk: &acp.SessionUpdateAgentMessageChunk{
				Content:       acp.TextBlock(content),
				SessionUpdate: "agent_message_chunk",
				Meta:          meta,
			},
		},
	}
}

// Start spawns an agent process with ACP mode.
func Start(ctx context.Context, agentName, command string, args []string, cwd string, env map[string]string) (*Process, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	configureProcessCommand(cmd, env)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	proc := &Process{
		agentName:    agentName,
		cmd:          cmd,
		sessions:     make(map[string]*sessionState),
		sessionsByID: make(map[string]*sessionState),
		waitCh:       make(chan error, 1),
	}
	proc.client = &mindfsClient{proc: proc}
	go streamProcessStderr(proc, stderr)
	go func() {
		proc.waitCh <- cmd.Wait()
	}()

	proc.conn = acp.NewClientSideConnection(proc.client, stdin, stdout)

	return proc, nil
}

// Initialize performs ACP handshake.
func (p *Process) Initialize(ctx context.Context) error {
	// Send initialize request
	resp, err := p.conn.Initialize(ctx, acp.InitializeRequest{
		ProtocolVersion: acp.ProtocolVersionNumber,
		ClientCapabilities: acp.ClientCapabilities{
			Terminal: true,
		},
		ClientInfo: &acp.Implementation{
			Name:    "mindfs",
			Version: "1.0.0",
		},
	})

	if err != nil {
		return err
	}
	if raw, err := json.Marshal(resp); err == nil {
		log.Printf("[agent/acp] initialize.resp.raw agent=%s resp=%s", p.agentLabel(), string(raw))
	}
	p.capability = CapabilitySnapshot{
		PromptSupportsAudio:   resp.AgentCapabilities.PromptCapabilities.Audio,
		PromptSupportsImage:   resp.AgentCapabilities.PromptCapabilities.Image,
		PromptSupportsContext: resp.AgentCapabilities.PromptCapabilities.EmbeddedContext,
	}
	return nil
}

// NewSession creates a new ACP session for the given MindFS session key.
func (p *Process) NewSession(ctx context.Context, sessionKey, cwd string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	// Check if session already exists
	if _, ok := p.sessions[sessionKey]; ok {
		return nil
	}

	resp, err := p.conn.NewSession(ctx, acp.NewSessionRequest{
		Cwd:        cwd,
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		return err
	}
	if raw, err := json.Marshal(resp); err == nil {
		log.Printf("[agent/acp] new_session.resp.raw agent=%s session_key=%s resp=%s", p.agentLabel(), sessionKey, string(raw))
	}
	sess := &sessionState{
		ID:     resp.SessionId,
		models: resp.Models,
	}
	if resp.Models != nil {
		p.models = resp.Models
	}
	p.sessions[sessionKey] = sess
	p.sessionsByID[string(resp.SessionId)] = sess
	return nil
}

// SetOnUpdate registers a callback for a specific session.
func (p *Process) SetOnUpdate(sessionKey string, onUpdate func(SessionUpdate)) {
	sess := p.getSessionByKey(sessionKey)
	if sess != nil {
		sess.setOnUpdate(onUpdate)
	}
}

// SendMessage sends a prompt to a specific session.
func (p *Process) SendMessage(ctx context.Context, sessionKey, content string) error {
	start := time.Now()
	sess := p.getSessionByKey(sessionKey)

	if sess == nil {
		return nil
	}
	log.Printf("[agent/acp] send.begin agent=%s session_key=%s content=%q", p.agentLabel(), sessionKey, content)

	promptCtx, promptCancel := context.WithCancel(ctx)
	promptID := time.Now().UnixNano()
	p.setActivePrompt(promptID, promptCancel)
	defer func() {
		p.clearActivePrompt(promptID)
		promptCancel()
	}()

	_, err := p.conn.Prompt(promptCtx, acp.PromptRequest{
		SessionId: sess.ID,
		Prompt: []acp.ContentBlock{
			acp.TextBlock(content),
		},
	})
	if err != nil {
		return p.wrapPromptError(sessionKey, string(sess.ID), err)
	}

	// Signal completion
	if onUpdate := sess.getOnUpdate(); onUpdate != nil {
		onUpdate(SessionUpdate{
			Type:      UpdateTypeMessageDone,
			SessionID: string(sess.ID),
		})
	}
	log.Printf("[agent/acp] send.done agent=%s session_key=%s duration_ms=%d", p.agentLabel(), sessionKey, time.Since(start).Milliseconds())

	return nil
}

func (p *Process) CancelCurrentTurn(sessionKey string) error {
	sess := p.getSessionByKey(sessionKey)
	if sess == nil {
		return nil
	}
	return p.conn.Cancel(context.Background(), acp.CancelNotification{
		SessionId: sess.ID,
	})
}

// CloseSession removes a session from the process.
func (p *Process) CloseSession(sessionKey string) {
	p.mu.Lock()
	if sess, ok := p.sessions[sessionKey]; ok {
		delete(p.sessionsByID, string(sess.ID))
		delete(p.sessions, sessionKey)
	}
	p.mu.Unlock()
}

// Close terminates the process.
func (p *Process) Close() error {
	p.mu.Lock()
	cmd := p.cmd
	waitCh := p.waitCh
	p.cmd = nil
	p.waitCh = nil
	p.mu.Unlock()

	if cmd == nil || cmd.Process == nil {
		return nil
	}

	pid := cmd.Process.Pid
	log.Printf("[agent/acp] process.close.begin agent=%s pid=%d", p.agentLabel(), pid)
	if err := killProcess(cmd.Process); err != nil && !strings.Contains(strings.ToLower(err.Error()), "process already finished") {
		log.Printf("[agent/acp] process.close.kill_error agent=%s pid=%d err=%v", p.agentLabel(), pid, err)
		return err
	}

	select {
	case err := <-waitCh:
		if err != nil && !strings.Contains(strings.ToLower(err.Error()), "signal: killed") {
			log.Printf("[agent/acp] process.close.wait_error agent=%s pid=%d err=%v", p.agentLabel(), pid, err)
			return err
		}
		log.Printf("[agent/acp] process.close.done agent=%s pid=%d", p.agentLabel(), pid)
		return nil
	case <-time.After(10 * time.Second):
		log.Printf("[agent/acp] process.close.timeout agent=%s pid=%d", p.agentLabel(), pid)
		return nil
	}
}

func killProcess(proc *os.Process) error {
	if proc == nil {
		return nil
	}
	return killProcessTree(proc)
}

// SessionID returns the ACP session ID for a MindFS session key.
func (p *Process) SessionID(sessionKey string) string {
	if sess := p.getSessionByKey(sessionKey); sess != nil {
		return string(sess.ID)
	}
	return ""
}

// Capability returns agent capabilities reported by initialize response.
func (p *Process) Capability() CapabilitySnapshot {
	return p.capability
}

func (p *Process) ModelState() *acp.SessionModelState {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.models
}

func (p *Process) SetModel(ctx context.Context, sessionKey, model string) error {
	sess := p.getSessionByKey(sessionKey)
	if sess == nil || strings.TrimSpace(model) == "" {
		return nil
	}
	_, err := p.conn.UnstableSetSessionModel(ctx, acp.UnstableSetSessionModelRequest{
		SessionId: sess.ID,
		ModelId:   acp.UnstableModelId(strings.TrimSpace(model)),
	})
	if err == nil {
		if state := sess.getModels(); state != nil {
			state.CurrentModelId = acp.ModelId(strings.TrimSpace(model))
			sess.setModels(state)
			p.mu.Lock()
			p.models = state
			p.mu.Unlock()
		}
	}
	return err
}

func (p *Process) SessionModelState(sessionKey string) *acp.SessionModelState {
	sess := p.getSessionByKey(sessionKey)
	if sess == nil {
		return nil
	}
	return sess.getModels()
}

func (p *Process) SessionCommands(sessionKey string) []acp.AvailableCommand {
	sess := p.getSessionByKey(sessionKey)
	if sess == nil {
		return nil
	}
	return sess.getCommands()
}

func (p *Process) RecentStderrHint() (string, bool) {
	return p.recentStderrHint()
}

func (p *Process) getSessionByKey(sessionKey string) *sessionState {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.sessions[sessionKey]
}

func (p *Process) getSessionByID(sessionID string) *sessionState {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.sessionsByID[sessionID]
}

// convertSessionUpdate converts acp-go SessionUpdate to internal format
func wrapSessionUpdate(sessionID string, update acp.SessionUpdate) SessionUpdate {
	result := SessionUpdate{
		SessionID: sessionID,
		Raw:       update,
	}
	switch {
	case update.AgentMessageChunk != nil:
		result.Type = UpdateTypeMessageChunk
	case update.AgentThoughtChunk != nil:
		result.Type = UpdateTypeThoughtChunk
	case update.ToolCall != nil:
		result.Type = UpdateTypeToolCall
	case update.ToolCallUpdate != nil:
		result.Type = UpdateTypeToolUpdate
	}
	return result
}

func streamProcessStderr(proc *Process, reader io.Reader) {
	if reader == nil {
		return
	}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		log.Printf("[agent/acp][stderr] agent=%s %s", proc.agentLabel(), line)
		proc.captureStderrHint(line)
	}
	if err := scanner.Err(); err != nil {
		log.Printf("[agent/acp][stderr] agent=%s stream_error=%v", proc.agentLabel(), err)
	}
}

func configureProcessCommand(cmd *exec.Cmd, env map[string]string) {
	if cmd == nil {
		return
	}
	configurePlatformProcessCommand(cmd)
	if len(env) == 0 {
		return
	}
	cmd.Env = cmd.Environ()
	for key, value := range env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
}

func (p *Process) wrapPromptError(sessionKey, sessionID string, err error) error {
	if hint, ok := p.recentStderrHint(); ok {
		log.Printf("[agent/acp] send.error agent=%s session_key=%s err=%v hint=%q", p.agentLabel(), sessionKey, err, hint)
		return errors.New(hint)
	}
	log.Printf("[agent/acp] send.error agent=%s session_key=%s err=%v", p.agentLabel(), sessionKey, err)
	return err
}

func (p *Process) captureStderrHint(line string) {
	if p == nil {
		return
	}
	p.stderrHint.mu.Lock()
	defer p.stderrHint.mu.Unlock()

	if strings.Contains(line, `"code":`) {
		p.stderrHint.expectMessage = true
		return
	}
	if !p.stderrHint.expectMessage {
		return
	}
	message, ok := parseStderrHintMessage(line)
	if !ok {
		return
	}
	p.setRecentStderrHintLocked(message)
	p.cancelActivePrompt()
}

func (p *Process) setRecentStderrHintLocked(message string) {
	p.stderrHint.message = message
	p.stderrHint.messageAt = time.Now()
	p.stderrHint.expectMessage = false
}

func parseStderrHintMessage(line string) (string, bool) {
	match := stderrMessagePattern.FindStringSubmatch(line)
	if len(match) < 2 {
		return "", false
	}
	return strings.TrimSpace(match[1]), true
}

func (p *Process) recentStderrHint() (string, bool) {
	if p == nil {
		return "", false
	}
	p.stderrHint.mu.Lock()
	defer p.stderrHint.mu.Unlock()
	if strings.TrimSpace(p.stderrHint.message) == "" {
		return "", false
	}
	if time.Since(p.stderrHint.messageAt) > 5*time.Minute {
		return "", false
	}
	return p.stderrHint.message, true
}

func (p *Process) setActivePrompt(id int64, cancel context.CancelFunc) {
	if p == nil {
		return
	}
	p.activePrompt.mu.Lock()
	p.activePrompt.id = id
	p.activePrompt.cancel = cancel
	p.activePrompt.mu.Unlock()
}

func (p *Process) clearActivePrompt(id int64) {
	if p == nil {
		return
	}
	p.activePrompt.mu.Lock()
	if p.activePrompt.id == id {
		p.activePrompt.id = 0
		p.activePrompt.cancel = nil
	}
	p.activePrompt.mu.Unlock()
}

func (p *Process) cancelActivePrompt() {
	if p == nil {
		return
	}
	p.activePrompt.mu.Lock()
	cancel := p.activePrompt.cancel
	p.activePrompt.id = 0
	p.activePrompt.cancel = nil
	p.activePrompt.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func sessionUpdateLogValue(data any) string {
	raw, err := json.Marshal(data)
	if err != nil {
		return `{"marshal_error":true}`
	}
	return string(raw)
}
