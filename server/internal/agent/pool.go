package agent

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"mindfs/server/internal/agent/acp"
	"mindfs/server/internal/agent/claude"
	"mindfs/server/internal/agent/codex"
	agenttypes "mindfs/server/internal/agent/types"
)

// Pool routes agent session creation to protocol-specific runtimes.
type Pool struct {
	cfg        Config
	processCtx context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	sessions   map[string]*sessionEntry
	acp        *acp.Runtime
	claude     *claude.Runtime
	codex      *codex.Runtime
}

type sessionEntry struct {
	agentName  string
	sessionKey string
	protocol   Protocol
	session    agenttypes.Session
}

// NewPool creates a new agent pool.
func NewPool(cfg Config) *Pool {
	processCtx, cancel := context.WithCancel(context.Background())
	return &Pool{
		cfg:        cfg,
		processCtx: processCtx,
		cancel:     cancel,
		sessions:   make(map[string]*sessionEntry),
		acp:        acp.NewRuntime(processCtx),
		claude:     claude.NewRuntime(),
		codex:      codex.NewRuntime(),
	}
}

// GetOrCreate returns an existing session handle or creates a new one.
func (p *Pool) GetOrCreate(ctx context.Context, in agenttypes.OpenSessionInput) (agenttypes.Session, error) {
	if in.SessionKey == "" {
		return nil, errors.New("session key required")
	}
	start := time.Now()
	log.Printf("[agent/pool] get_or_create.begin session=%s agent=%s", in.SessionKey, in.AgentName)

	p.mu.Lock()
	defer p.mu.Unlock()

	if entry, ok := p.sessions[in.SessionKey]; ok {
		log.Printf("[agent/pool] get_or_create.hit session=%s agent=%s duration_ms=%d", in.SessionKey, in.AgentName, time.Since(start).Milliseconds())
		return entry.session, nil
	}

	def, ok := p.cfg.GetAgent(in.AgentName)
	if !ok {
		return nil, errors.New("agent not configured: " + in.AgentName)
	}
	protocol := def.Protocol
	if protocol == "" {
		protocol = DefaultProtocol(in.AgentName)
	}

	sess, err := p.openSession(ctx, protocol, def, in)
	if err != nil {
		return nil, err
	}

	p.sessions[in.SessionKey] = &sessionEntry{
		agentName:  in.AgentName,
		sessionKey: in.SessionKey,
		protocol:   protocol,
		session:    sess,
	}
	log.Printf("[agent/pool] get_or_create.done session=%s agent=%s total_ms=%d", in.SessionKey, in.AgentName, time.Since(start).Milliseconds())
	return sess, nil
}

func (p *Pool) openSession(ctx context.Context, protocol Protocol, def Definition, in agenttypes.OpenSessionInput) (agenttypes.Session, error) {
	switch protocol {
	case ProtocolClaudeSDK:
		return p.claude.OpenSession(ctx, claude.OpenOptions{
			AgentName:  in.AgentName,
			SessionKey: in.SessionKey,
			RootPath:   in.RootPath,
			Command:    def.Command,
			Args:       append([]string{}, def.Args...),
			Env:        cloneEnv(def.Env),
		})
	case ProtocolCodexSDK:
		return p.codex.OpenSession(ctx, codex.OpenOptions{
			AgentName:  in.AgentName,
			SessionKey: in.SessionKey,
			RootPath:   in.RootPath,
			Command:    def.Command,
			Args:       append([]string{}, def.Args...),
			Env:        cloneEnv(def.Env),
		})
	case ProtocolACP:
		fallthrough
	default:
		return p.acp.OpenSession(ctx, acp.OpenOptions{
			AgentName:  in.AgentName,
			SessionKey: in.SessionKey,
			RootPath:   in.RootPath,
			Command:    def.Command,
			Args:       def.BuildArgs(in.RootPath),
			Env:        cloneEnv(def.Env),
			Cwd:        def.ResolveCwd(in.RootPath),
		})
	}
}

func cloneEnv(env map[string]string) map[string]string {
	if len(env) == 0 {
		return nil
	}
	out := make(map[string]string, len(env))
	for key, value := range env {
		out[key] = value
	}
	return out
}

// Close closes a session (not the underlying runtime pool).
func (p *Pool) Close(sessionKey string) {
	p.mu.Lock()
	entry, ok := p.sessions[sessionKey]
	if ok {
		delete(p.sessions, sessionKey)
	}
	p.mu.Unlock()

	if !ok {
		return
	}
	if entry.session != nil {
		_ = entry.session.Close()
	}
	if entry.protocol == ProtocolACP {
		p.acp.CloseSession(sessionKey)
	}
}

// Config returns the pool configuration.
func (p *Pool) Config() Config {
	return p.cfg
}

// Get returns an existing session handle if present.
func (p *Pool) Get(sessionKey string) (agenttypes.Session, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry, ok := p.sessions[sessionKey]
	if !ok || entry == nil || entry.session == nil {
		return nil, false
	}
	return entry.session, true
}

// Context returns the pool lifecycle context (read-only).
func (p *Pool) Context() context.Context {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.processCtx != nil {
		return p.processCtx
	}
	return context.Background()
}

// CloseAll closes all runtime resources.
func (p *Pool) CloseAll() {
	p.mu.Lock()
	p.sessions = make(map[string]*sessionEntry)
	cancel := p.cancel
	p.cancel = nil
	acpRuntime := p.acp
	claudeRuntime := p.claude
	codexRuntime := p.codex
	p.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if acpRuntime != nil {
		acpRuntime.CloseAll()
	}
	if claudeRuntime != nil {
		claudeRuntime.CloseAll()
	}
	if codexRuntime != nil {
		codexRuntime.CloseAll()
	}
}
