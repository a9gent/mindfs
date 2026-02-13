package agent

import (
	"context"
	"errors"
	"sync"

	acp "github.com/coder/acp-go-sdk"
	acpproc "mindfs/server/internal/agent/acp"
)

// Pool manages agent processes. Each agent type has one shared process
// that supports multiple sessions via ACP protocol.
type Pool struct {
	cfg       Config
	mu        sync.Mutex
	processes map[string]*acpproc.Process // agentName -> process
	sessions  map[string]*sessionEntry    // sessionKey -> entry
}

type sessionEntry struct {
	agentName  string
	sessionKey string
	session    Session
}

// NewPool creates a new agent pool.
func NewPool(cfg Config) *Pool {
	return &Pool{
		cfg:       cfg,
		processes: make(map[string]*acpproc.Process),
		sessions:  make(map[string]*sessionEntry),
	}
}

// GetOrCreate returns an existing session handle or creates a new one.
func (p *Pool) GetOrCreate(ctx context.Context, sessionKey, agentName, rootPath string) (Session, error) {
	if sessionKey == "" {
		return nil, errors.New("session key required")
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	// Check if session already exists
	if entry, ok := p.sessions[sessionKey]; ok {
		return entry.session, nil
	}

	// Get agent definition
	def, ok := p.cfg.Agents[agentName]
	if !ok {
		return nil, errors.New("agent not configured: " + agentName)
	}

	// Get or create process for this agent type
	proc, ok := p.processes[agentName]
	if !ok {
		args := def.BuildArgs(rootPath)
		cwd := def.ResolveCwd(rootPath)
		var err error
		proc, err = acpproc.Start(ctx, def.Command, args, cwd, def.Env)
		if err != nil {
			return nil, err
		}
		if err := proc.Initialize(ctx); err != nil {
			_ = proc.Close()
			return nil, err
		}
		p.processes[agentName] = proc
	}

	// Create a new session within the process (with its own cwd)
	if err := proc.NewSession(ctx, sessionKey, rootPath); err != nil {
		return nil, err
	}

	sess := &pooledSession{
		proc:       proc,
		sessionKey: sessionKey,
	}
	p.sessions[sessionKey] = &sessionEntry{
		agentName:  agentName,
		sessionKey: sessionKey,
		session:    sess,
	}

	return sess, nil
}

// Close closes a session (not the process).
func (p *Pool) Close(sessionKey string) {
	p.mu.Lock()
	entry, ok := p.sessions[sessionKey]
	if ok {
		delete(p.sessions, sessionKey)
	}
	p.mu.Unlock()

	if ok && entry.session != nil {
		_ = entry.session.Close()
	}
}

// Config returns the pool configuration.
func (p *Pool) Config() Config {
	return p.cfg
}

// CloseAll closes all processes.
func (p *Pool) CloseAll() {
	p.mu.Lock()
	procs := make([]*acpproc.Process, 0, len(p.processes))
	for _, proc := range p.processes {
		procs = append(procs, proc)
	}
	p.processes = make(map[string]*acpproc.Process)
	p.sessions = make(map[string]*sessionEntry)
	p.mu.Unlock()

	for _, proc := range procs {
		_ = proc.Close()
	}
}

type pooledSession struct {
	proc       *acpproc.Process
	sessionKey string
}

func (s *pooledSession) SendMessage(ctx context.Context, content string) error {
	return s.proc.SendMessage(ctx, s.sessionKey, content)
}

func (s *pooledSession) OnUpdate(onUpdate func(Event)) {
	s.proc.SetOnUpdate(s.sessionKey, func(update acpproc.SessionUpdate) {
		if onUpdate != nil {
			onUpdate(convertUnifiedEvent(update))
		}
	})
}

func (s *pooledSession) SessionID() string {
	return s.proc.SessionID(s.sessionKey)
}

func (s *pooledSession) Close() error {
	s.proc.CloseSession(s.sessionKey)
	return nil
}

func convertUnifiedEvent(update acpproc.SessionUpdate) Event {
	ev := Event{
		Type:      EventType(update.Type),
		SessionID: update.SessionID,
	}
	raw := update.Raw
	switch update.Type {
	case acpproc.UpdateTypeMessageChunk:
		if raw.AgentMessageChunk != nil && raw.AgentMessageChunk.Content.Text != nil {
			ev.Data = MessageChunk{Content: raw.AgentMessageChunk.Content.Text.Text}
		}
	case acpproc.UpdateTypeThoughtChunk:
		if raw.AgentThoughtChunk != nil && raw.AgentThoughtChunk.Content.Text != nil {
			ev.Data = ThoughtChunk{Content: raw.AgentThoughtChunk.Content.Text.Text}
		}
	case acpproc.UpdateTypeToolCall:
		if raw.ToolCall != nil {
			locations := make([]ToolCallLocation, 0, len(raw.ToolCall.Locations))
			for _, loc := range raw.ToolCall.Locations {
				locations = append(locations, ToolCallLocation{
					Path: loc.Path,
					Line: loc.Line,
				})
			}
			status := "running"
			if raw.ToolCall.Status != "" {
				status = string(raw.ToolCall.Status)
			}
			ev.Data = ToolCall{
				CallID:    string(raw.ToolCall.ToolCallId),
				Name:      raw.ToolCall.Title,
				Status:    status,
				Kind:      ToolKind(raw.ToolCall.Kind),
				Content:   convertToolCallContent(raw.ToolCall.Content),
				Locations: locations,
			}
		}
	case acpproc.UpdateTypeToolUpdate:
		if raw.ToolCallUpdate != nil {
			status := "complete"
			if raw.ToolCallUpdate.Status != nil && *raw.ToolCallUpdate.Status == acp.ToolCallStatusFailed {
				status = "failed"
			}
			kind := ToolKindOther
			if raw.ToolCallUpdate.Kind != nil {
				kind = ToolKind(*raw.ToolCallUpdate.Kind)
			}
			name := ""
			if raw.ToolCallUpdate.Title != nil {
				name = *raw.ToolCallUpdate.Title
			}
			locations := make([]ToolCallLocation, 0, len(raw.ToolCallUpdate.Locations))
			for _, loc := range raw.ToolCallUpdate.Locations {
				locations = append(locations, ToolCallLocation{
					Path: loc.Path,
					Line: loc.Line,
				})
			}
			ev.Data = ToolCall{
				CallID:    string(raw.ToolCallUpdate.ToolCallId),
				Name:      name,
				Status:    status,
				Kind:      kind,
				Content:   convertToolCallContent(raw.ToolCallUpdate.Content),
				Locations: locations,
			}
		}
	}
	return ev
}

func convertToolCallContent(items []acp.ToolCallContent) []ToolCallContentItem {
	if len(items) == 0 {
		return nil
	}
	out := make([]ToolCallContentItem, 0, len(items))
	for _, item := range items {
		if item.Content != nil {
			contentItem := ToolCallContentItem{Type: "text"}
			block := item.Content.Content
			if block.Text != nil {
				contentItem.Text = block.Text.Text
				out = append(out, contentItem)
			}
			continue
		}
		if item.Diff != nil {
			out = append(out, ToolCallContentItem{
				Type:    "diff",
				Path:    item.Diff.Path,
				OldText: item.Diff.OldText,
				NewText: item.Diff.NewText,
			})
			continue
		}
	}
	return out
}
