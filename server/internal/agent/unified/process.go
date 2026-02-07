// Package unified provides a unified ACP-based agent process implementation.
// All agents (Claude, Gemini, Codex) are accessed through the same ACP protocol.
package unified

import (
	"context"
	"os/exec"
	"sync"

	acp "github.com/coder/acp-go-sdk"
)

// Process manages an agent process using the ACP protocol.
// This unified implementation works with any ACP-compatible agent:
// - claude (via claude-code-acp wrapper)
// - gemini (via --experimental-acp flag)
// - codex (via codex-acp wrapper)
type Process struct {
	cmd    *exec.Cmd
	conn   *acp.ClientSideConnection
	client *mindfsClient

	mu       sync.RWMutex
	sessions map[string]*Session // sessionKey -> Session
}

// Session represents an ACP session within the process.
type Session struct {
	ID       acp.SessionId
	Key      string // MindFS session key
	onUpdate func(SessionUpdate)
	mu       sync.Mutex
}

// SessionUpdate is the internal session update type.
type SessionUpdate struct {
	Type      UpdateType
	SessionID string
	Data      any // Type-specific data
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

// MessageChunk contains text content from agent response.
type MessageChunk struct {
	Content string
}

// ThoughtChunk contains agent's internal reasoning.
type ThoughtChunk struct {
	Content string
}

// ToolKind defines the category of tool being invoked.
type ToolKind string

const (
	ToolKindRead       ToolKind = "read"
	ToolKindEdit       ToolKind = "edit"
	ToolKindDelete     ToolKind = "delete"
	ToolKindMove       ToolKind = "move"
	ToolKindSearch     ToolKind = "search"
	ToolKindExecute    ToolKind = "execute"
	ToolKindThink      ToolKind = "think"
	ToolKindFetch      ToolKind = "fetch"
	ToolKindSwitchMode ToolKind = "switch_mode"
	ToolKindOther      ToolKind = "other"
)

// ToolCallLocation represents a file location affected by a tool call.
type ToolCallLocation struct {
	Path string
	Line *int
}

// ToolCall contains tool invocation information.
type ToolCall struct {
	CallID    string
	Name      string
	Status    string
	Kind      ToolKind
	Locations []ToolCallLocation
}

// ToolCallUpdate contains tool execution result.
type ToolCallUpdate struct {
	CallID string
	Status string
	Result string
}

// IsWriteOperation returns true if this tool call modifies files.
func (tc ToolCall) IsWriteOperation() bool {
	switch tc.Kind {
	case ToolKindEdit, ToolKindDelete, ToolKindMove:
		return true
	default:
		return false
	}
}

// GetAffectedPaths returns all file paths affected by this tool call.
func (tc ToolCall) GetAffectedPaths() []string {
	paths := make([]string, 0, len(tc.Locations))
	for _, loc := range tc.Locations {
		if loc.Path != "" {
			paths = append(paths, loc.Path)
		}
	}
	return paths
}

// SessionHandle wraps a session to implement the Process interface.
type SessionHandle struct {
	Process    *Process
	SessionKey string
}

// SendMessage sends a message and streams responses via callback.
func (h *SessionHandle) SendMessage(ctx context.Context, content string, onUpdate func(SessionUpdate)) error {
	return h.Process.SendMessage(ctx, h.SessionKey, content, onUpdate)
}

// SessionID returns the current session ID.
func (h *SessionHandle) SessionID() string {
	return h.Process.SessionID(h.SessionKey)
}

// Close removes the session from the process (does not terminate the process).
func (h *SessionHandle) Close() error {
	h.Process.CloseSession(h.SessionKey)
	return nil
}

// mindfsClient implements acp.Client interface
type mindfsClient struct {
	proc *Process
}

func (c *mindfsClient) SessionUpdate(ctx context.Context, params acp.SessionNotification) error {
	c.proc.mu.RLock()
	session := c.proc.findSessionByID(string(params.SessionId))
	c.proc.mu.RUnlock()

	if session == nil || session.onUpdate == nil {
		return nil
	}

	// Convert acp.SessionUpdate to internal format
	internalUpdate := convertSessionUpdate(string(params.SessionId), params.Update)
	if internalUpdate.Type != "" {
		session.onUpdate(internalUpdate)
	}
	return nil
}

func (c *mindfsClient) RequestPermission(ctx context.Context, params acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
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
func Start(ctx context.Context, command string, args []string, cwd string, env map[string]string) (*Process, error) {
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
		cmd:      cmd,
		sessions: make(map[string]*Session),
	}
	proc.client = &mindfsClient{proc: proc}

	// Create ACP connection - coder/acp-go-sdk uses io.Writer and io.Reader directly
	proc.conn = acp.NewClientSideConnection(proc.client, stdin, stdout)

	return proc, nil
}

// Initialize performs ACP handshake.
func (p *Process) Initialize(ctx context.Context) error {
	// Send initialize request
	_, err := p.conn.Initialize(ctx, acp.InitializeRequest{
		ProtocolVersion: acp.ProtocolVersionNumber,
		ClientCapabilities: acp.ClientCapabilities{
			Terminal: true,
		},
		ClientInfo: &acp.Implementation{
			Name:    "mindfs",
			Version: "1.0.0",
		},
	})
	return err
}

// NewSession creates a new ACP session for the given MindFS session key.
func (p *Process) NewSession(ctx context.Context, sessionKey, cwd string) (*Session, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	// Check if session already exists
	if sess, ok := p.sessions[sessionKey]; ok {
		return sess, nil
	}

	resp, err := p.conn.NewSession(ctx, acp.NewSessionRequest{
		Cwd: cwd,
	})
	if err != nil {
		return nil, err
	}

	sess := &Session{
		ID:  resp.SessionId,
		Key: sessionKey,
	}
	p.sessions[sessionKey] = sess
	return sess, nil
}

// GetSession returns an existing session by MindFS session key.
func (p *Process) GetSession(sessionKey string) *Session {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.sessions[sessionKey]
}

// SendMessage sends a prompt to a specific session.
func (p *Process) SendMessage(ctx context.Context, sessionKey, content string, onUpdate func(SessionUpdate)) error {
	p.mu.RLock()
	sess := p.sessions[sessionKey]
	p.mu.RUnlock()

	if sess == nil {
		return nil
	}

	sess.mu.Lock()
	sess.onUpdate = onUpdate
	sess.mu.Unlock()

	_, err := p.conn.Prompt(ctx, acp.PromptRequest{
		SessionId: sess.ID,
		Prompt: []acp.ContentBlock{
			acp.TextBlock(content),
		},
	})

	// Signal completion
	if onUpdate != nil {
		onUpdate(SessionUpdate{
			Type:      UpdateTypeMessageDone,
			SessionID: string(sess.ID),
		})
	}

	return err
}

// CloseSession removes a session from the process.
func (p *Process) CloseSession(sessionKey string) {
	p.mu.Lock()
	delete(p.sessions, sessionKey)
	p.mu.Unlock()
}

// Close terminates the process.
func (p *Process) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	return nil
}

// SessionID returns the ACP session ID for a MindFS session key.
func (p *Process) SessionID(sessionKey string) string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if sess, ok := p.sessions[sessionKey]; ok {
		return string(sess.ID)
	}
	return ""
}

func (p *Process) findSessionByID(sessionID string) *Session {
	for _, sess := range p.sessions {
		if string(sess.ID) == sessionID {
			return sess
		}
	}
	return nil
}

// convertSessionUpdate converts acp-go SessionUpdate to internal format
func convertSessionUpdate(sessionID string, update acp.SessionUpdate) SessionUpdate {
	result := SessionUpdate{SessionID: sessionID}

	if update.AgentMessageChunk != nil {
		text := ""
		if update.AgentMessageChunk.Content.Text != nil {
			text = update.AgentMessageChunk.Content.Text.Text
		}
		result.Type = UpdateTypeMessageChunk
		result.Data = MessageChunk{Content: text}
	} else if update.AgentThoughtChunk != nil {
		text := ""
		if update.AgentThoughtChunk.Content.Text != nil {
			text = update.AgentThoughtChunk.Content.Text.Text
		}
		result.Type = UpdateTypeThoughtChunk
		result.Data = ThoughtChunk{Content: text}
	} else if update.ToolCall != nil {
		status := "running"
		if update.ToolCall.Status != "" {
			status = string(update.ToolCall.Status)
		}
		// Convert locations
		locations := make([]ToolCallLocation, 0, len(update.ToolCall.Locations))
		for _, loc := range update.ToolCall.Locations {
			tcLoc := ToolCallLocation{Path: loc.Path}
			if loc.Line != nil {
				tcLoc.Line = loc.Line
			}
			locations = append(locations, tcLoc)
		}
		result.Type = UpdateTypeToolCall
		result.Data = ToolCall{
			CallID:    string(update.ToolCall.ToolCallId),
			Name:      update.ToolCall.Title,
			Status:    status,
			Kind:      ToolKind(update.ToolCall.Kind),
			Locations: locations,
		}
	} else if update.ToolCallUpdate != nil {
		status := "complete"
		if update.ToolCallUpdate.Status != nil && *update.ToolCallUpdate.Status == acp.ToolCallStatusFailed {
			status = "failed"
		}
		result.Type = UpdateTypeToolUpdate
		result.Data = ToolCallUpdate{
			CallID: string(update.ToolCallUpdate.ToolCallId),
			Status: status,
		}
	}

	return result
}
