// Package acp provides ACP-based agent process implementation.
// All supported agents are accessed through ACP.
package acp

import (
	"context"
	"encoding/json"
	"log"
	"os/exec"
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

	mu           sync.RWMutex
	sessions     map[string]*sessionState // sessionKey -> state
	sessionsByID map[string]*sessionState // ACP session id -> state
	capability   CapabilitySnapshot
	models       *acp.SessionModelState
}

type CapabilitySnapshot struct {
	PromptSupportsAudio   bool
	PromptSupportsImage   bool
	PromptSupportsContext bool
}

type sessionState struct {
	ID       acp.SessionId
	models   *acp.SessionModelState
	onUpdate func(SessionUpdate)
	mu       sync.RWMutex
}

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
	if internalUpdate.Type != "" {
		switch internalUpdate.Type {
		case UpdateTypeMessageChunk:
			content := ""
			if params.Update.AgentMessageChunk != nil && params.Update.AgentMessageChunk.Content.Text != nil {
				content = params.Update.AgentMessageChunk.Content.Text.Text
			}
			log.Printf("[agent/acp] session.update agent=%s session_id=%s type=%s content=%q", c.proc.agentLabel(), internalUpdate.SessionID, internalUpdate.Type, content)
		default:
			log.Printf("[agent/acp] session.update agent=%s session_id=%s type=%s", c.proc.agentLabel(), internalUpdate.SessionID, internalUpdate.Type)
		}
		handler(internalUpdate)
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

// Start spawns an agent process with ACP mode.
func Start(ctx context.Context, agentName, command string, args []string, cwd string, env map[string]string) (*Process, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	if len(env) > 0 {
		cmd.Env = cmd.Environ()
		for k, v := range env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	proc := &Process{
		agentName:    agentName,
		cmd:          cmd,
		sessions:     make(map[string]*sessionState),
		sessionsByID: make(map[string]*sessionState),
	}
	proc.client = &mindfsClient{proc: proc}

	// Create ACP connection - coder/acp-go-sdk uses io.Writer and io.Reader directly
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
	log.Printf("[agent/acp] send.begin agent=%s session_key=%s session_id=%s prompt_chars=%d content=%q", p.agentLabel(), sessionKey, sess.ID, len(content), content)

	_, err := p.conn.Prompt(ctx, acp.PromptRequest{
		SessionId: sess.ID,
		Prompt: []acp.ContentBlock{
			acp.TextBlock(content),
		},
	})
	if err != nil {
		log.Printf("[agent/acp] send.error agent=%s session_key=%s session_id=%s err=%v", p.agentLabel(), sessionKey, sess.ID, err)
		return err
	}

	// Signal completion
	if onUpdate := sess.getOnUpdate(); onUpdate != nil {
		onUpdate(SessionUpdate{
			Type:      UpdateTypeMessageDone,
			SessionID: string(sess.ID),
		})
	}
	log.Printf("[agent/acp] send.done agent=%s session_key=%s session_id=%s duration_ms=%d", p.agentLabel(), sessionKey, sess.ID, time.Since(start).Milliseconds())

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
	defer p.mu.Unlock()
	if p.cmd != nil && p.cmd.Process != nil {
		p.cmd.Process.Kill()
	}
	return nil
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
	_, err := p.conn.SetSessionModel(ctx, acp.SetSessionModelRequest{
		SessionId: sess.ID,
		ModelId:   acp.ModelId(strings.TrimSpace(model)),
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
