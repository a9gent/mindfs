package agent

import (
	"context"
	"errors"
	"sync"

	"mindfs/server/internal/agent/unified"
)

// Pool manages agent processes. Each agent type has one shared process
// that supports multiple sessions via ACP protocol.
type Pool struct {
	cfg       Config
	mu        sync.Mutex
	processes map[string]*unified.Process // agentName -> Process
	sessions  map[string]*sessionEntry    // sessionKey -> entry
}

type sessionEntry struct {
	agentName  string
	sessionKey string
	handle     *unified.SessionHandle
}

// NewPool creates a new agent pool.
func NewPool(cfg Config) *Pool {
	return &Pool{
		cfg:       cfg,
		processes: make(map[string]*unified.Process),
		sessions:  make(map[string]*sessionEntry),
	}
}

// GetOrCreate returns an existing session handle or creates a new one.
func (p *Pool) GetOrCreate(ctx context.Context, sessionKey, agentName, rootPath string) (Process, error) {
	if sessionKey == "" {
		return nil, errors.New("session key required")
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	// Check if session already exists
	if entry, ok := p.sessions[sessionKey]; ok {
		return entry.handle, nil
	}

	// Get agent definition
	def, ok := p.cfg.Agents[agentName]
	if !ok {
		return nil, errors.New("agent not configured: " + agentName)
	}

	// Get or create process for this agent type
	proc, ok := p.processes[agentName]
	if !ok {
		// First process - use provided rootPath as initial cwd
		args := def.BuildArgs(rootPath)
		cwd := def.ResolveCwd(rootPath)
		var err error
		proc, err = unified.Start(ctx, def.Command, args, cwd, def.Env)
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
	_, err := proc.NewSession(ctx, sessionKey, rootPath)
	if err != nil {
		return nil, err
	}

	handle := &unified.SessionHandle{Process: proc, SessionKey: sessionKey}
	p.sessions[sessionKey] = &sessionEntry{
		agentName:  agentName,
		sessionKey: sessionKey,
		handle:     handle,
	}

	return handle, nil
}

// Close closes a session (not the process).
func (p *Pool) Close(sessionKey string) {
	p.mu.Lock()
	entry, ok := p.sessions[sessionKey]
	if ok {
		delete(p.sessions, sessionKey)
	}
	p.mu.Unlock()

	if ok && entry.handle != nil {
		_ = entry.handle.Close()
	}
}

// Config returns the pool configuration.
func (p *Pool) Config() Config {
	return p.cfg
}

// CloseAll closes all processes.
func (p *Pool) CloseAll() {
	p.mu.Lock()
	procs := make([]*unified.Process, 0, len(p.processes))
	for _, proc := range p.processes {
		procs = append(procs, proc)
	}
	p.processes = make(map[string]*unified.Process)
	p.sessions = make(map[string]*sessionEntry)
	p.mu.Unlock()

	for _, proc := range procs {
		_ = proc.Close()
	}
}
