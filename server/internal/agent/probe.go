package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
)

type Status struct {
	Name           string                 `json:"name"`
	Available      bool                   `json:"available"`
	Version        string                 `json:"version,omitempty"`
	Error          string                 `json:"error,omitempty"`
	LastProbe      time.Time              `json:"last_probe"`
	CurrentModelID string                 `json:"current_model_id,omitempty"`
	Models         []agenttypes.ModelInfo `json:"models,omitempty"`
	ModelsError    string                 `json:"models_error,omitempty"`
}

const (
	probeSessionTimeout     = 45 * time.Second
	probeInteractionTimeout = 3 * time.Minute
	probeModelListTimeout   = 30 * time.Second
)

// Prober 管理 Agent 可用性探测
type Prober struct {
	cfg           *Config
	pool          *Pool
	statuses      map[string]Status
	mu            sync.RWMutex
	probeInterval time.Duration
	stopCh        chan struct{}
	listeners     []func(Status)
}

func NewProber(cfg *Config, pool *Pool, probeInterval time.Duration) *Prober {
	if probeInterval <= 0 {
		probeInterval = 5 * time.Minute
	}
	p := &Prober{
		cfg:           cfg,
		pool:          pool,
		statuses:      make(map[string]Status),
		probeInterval: probeInterval,
		stopCh:        make(chan struct{}),
	}
	// Seed configured agents so API can return stable list before first probe completes.
	if cfg != nil {
		now := time.Now().UTC()
		for _, def := range cfg.Agents {
			p.statuses[def.Name] = unavailableStatus(def.Name, "probing", now)
		}
	}
	return p
}

// Start 启动定期探测
func (p *Prober) Start(ctx context.Context) {
	// 首次全量探测放到后台，避免阻塞服务启动和请求处理。
	go p.ProbeAll(ctx)

	// 启动定期探测：仅重试失败状态
	ticker := time.NewTicker(p.probeInterval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				p.probeFailedOnly(ctx)
			case <-p.stopCh:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
}

// Stop 停止定期探测
func (p *Prober) Stop() {
	select {
	case <-p.stopCh:
		return
	default:
		close(p.stopCh)
	}
}

// ProbeAll 探测所有配置的 Agent
func (p *Prober) ProbeAll(ctx context.Context) []Status {
	if p.cfg == nil {
		return nil
	}

	statuses := make([]Status, 0, len(p.cfg.Agents))
	for _, def := range p.cfg.Agents {
		status := p.probeAgent(ctx, def.Name, def)
		statuses = append(statuses, status)
		p.setStatus(status)
	}
	return statuses
}

// ProbeOne 探测单个 Agent 并更新缓存
func (p *Prober) ProbeOne(ctx context.Context, name string) Status {
	if p.cfg == nil {
		return unavailableStatus(name, "config not loaded", time.Now().UTC())
	}

	def, ok := p.cfg.GetAgent(name)
	if !ok {
		return unavailableStatus(name, "agent not configured", time.Now().UTC())
	}

	status := p.probeAgent(ctx, name, def)
	p.setStatus(status)

	return status
}

// ReportFailure marks an agent as unavailable due to runtime interaction/probe failure.
func (p *Prober) ReportFailure(name string, err error) {
	msg := "unknown failure"
	if err != nil {
		msg = err.Error()
	}
	p.setStatus(unavailableStatus(name, msg, time.Now().UTC()))
}

// ReportSuccess marks an agent as available due to successful runtime interaction.
func (p *Prober) ReportSuccess(name string) {
	p.mu.Lock()
	st := p.statuses[name]
	st.Name = name
	st.Available = true
	st.Error = ""
	st.LastProbe = time.Now().UTC()
	p.mu.Unlock()
	p.setStatus(st)
}

// GetStatus 获取缓存的 Agent 状态
func (p *Prober) GetStatus(name string) (Status, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	status, ok := p.statuses[name]
	return status, ok
}

// GetAllStatuses 获取所有缓存的 Agent 状态
func (p *Prober) GetAllStatuses() []Status {
	p.mu.RLock()
	defer p.mu.RUnlock()

	statuses := make([]Status, 0, len(p.statuses))
	seen := make(map[string]struct{}, len(p.statuses))

	if p.cfg != nil {
		for _, def := range p.cfg.Agents {
			if st, ok := p.statuses[def.Name]; ok {
				statuses = append(statuses, st)
			}
			seen[def.Name] = struct{}{}
		}
	}

	extra := make([]Status, 0)
	for name, st := range p.statuses {
		if _, ok := seen[name]; ok {
			continue
		}
		extra = append(extra, st)
	}
	sort.Slice(extra, func(i, j int) bool {
		return extra[i].Name < extra[j].Name
	})
	statuses = append(statuses, extra...)

	return statuses
}

// IsAvailable 检查 Agent 是否可用
func (p *Prober) IsAvailable(name string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	status, ok := p.statuses[name]
	return ok && status.Available
}

// ProbeAgent 探测单个 Agent
func ProbeAgent(ctx context.Context, name string, def Definition) Status {
	return probeAgentWithPool(ctx, name, def, nil)
}

func (p *Prober) probeAgent(ctx context.Context, name string, def Definition) Status {
	return probeAgentWithPool(ctx, name, def, p.pool)
}

func probeAgentWithPool(ctx context.Context, name string, def Definition, pool *Pool) Status {
	status := unavailableStatus(name, "", time.Now().UTC())
	if def.Command == "" {
		status.Error = "command required"
		return status
	}
	if _, err := exec.LookPath(def.Command); err != nil {
		status.Error = err.Error()
		return status
	}

	tmpRoot, err := os.MkdirTemp("", "mindfs-agent-probe-*")
	if err != nil {
		status.Error = err.Error()
		return status
	}
	defer os.RemoveAll(tmpRoot)

	pool, ownsPool := resolveProbePool(def, pool)
	if ownsPool {
		defer pool.CloseAll()
	}

	sessionKey := "probe-" + time.Now().UTC().Format("20060102-150405")
	defer pool.Close(sessionKey)
	sessionCtx, sessionCancel := context.WithTimeout(ctx, probeSessionTimeout)
	defer sessionCancel()
	sess, err := pool.GetOrCreate(sessionCtx, agenttypes.OpenSessionInput{
		SessionKey: sessionKey,
		AgentName:  name,
		Probe:      true,
		RootPath:   tmpRoot,
	})
	if err != nil {
		status.Error = err.Error()
		return status
	}

	interactionCtx, interactionCancel := context.WithTimeout(ctx, probeInteractionTimeout)
	defer interactionCancel()
	if err := VerifySessionInteraction(interactionCtx, sess); err != nil {
		status.Error = err.Error()
		return status
	}

	status.Available = true
	populateProbeModels(ctx, sess, &status)
	return status
}

func (p *Prober) probeFailedOnly(ctx context.Context) {
	if p.cfg == nil {
		return
	}
	for _, def := range p.cfg.Agents {
		name := def.Name
		p.mu.RLock()
		st, ok := p.statuses[name]
		p.mu.RUnlock()
		if ok && st.Available {
			continue
		}
		status := p.probeAgent(ctx, name, def)
		p.setStatus(status)
	}
}

// AddListener registers a callback invoked when an agent status changes.
func (p *Prober) AddListener(listener func(Status)) {
	if listener == nil {
		return
	}
	p.mu.Lock()
	p.listeners = append(p.listeners, listener)
	p.mu.Unlock()
}

func statusChanged(prev Status, next Status) bool {
	if prev.Name != next.Name {
		return true
	}
	if prev.Available != next.Available {
		return true
	}
	if prev.Version != next.Version {
		return true
	}
	if prev.Error != next.Error {
		return true
	}
	if prev.CurrentModelID != next.CurrentModelID {
		return true
	}
	if prev.ModelsError != next.ModelsError {
		return true
	}
	if len(prev.Models) != len(next.Models) {
		return true
	}
	for i := range prev.Models {
		if prev.Models[i] != next.Models[i] {
			return true
		}
	}
	return false
}

func (p *Prober) setStatus(status Status) {
	status = normalizeStatus(status)
	p.mu.Lock()
	prev, hadPrev := p.statuses[status.Name]
	p.statuses[status.Name] = status
	listeners := append([]func(Status){}, p.listeners...)
	p.mu.Unlock()

	if hadPrev && !statusChanged(prev, status) {
		return
	}
	for _, listener := range listeners {
		listener(status)
	}
}

func unavailableStatus(name, errMsg string, ts time.Time) Status {
	return Status{
		Name:      name,
		Available: false,
		Error:     errMsg,
		LastProbe: ts,
	}
}

func resolveProbePool(def Definition, shared *Pool) (*Pool, bool) {
	if shared != nil {
		return shared, false
	}
	return NewPool(Config{Agents: []Definition{def}}), true
}

func populateProbeModels(ctx context.Context, sess agenttypes.Session, status *Status) {
	modelsCtx, modelsCancel := context.WithTimeout(ctx, probeModelListTimeout)
	defer modelsCancel()

	models, err := sess.ListModels(modelsCtx)
	if err != nil {
		status.ModelsError = err.Error()
		return
	}
	status.CurrentModelID = models.CurrentModelID
	status.Models = models.Models
}

func normalizeStatus(status Status) Status {
	if status.Available {
		return status
	}
	status.CurrentModelID = ""
	status.Models = nil
	status.ModelsError = ""
	return status
}

// VerifySessionInteraction sends a deterministic ping prompt and verifies the response contains the token.
func VerifySessionInteraction(ctx context.Context, sess agenttypes.Session) error {
	if sess == nil {
		return errors.New("session required")
	}

	token := "MINDFS_PING_TOKEN_" + time.Now().UTC().Format("150405")
	var (
		mu      sync.Mutex
		text    strings.Builder
		gotDone bool
		doneCh  = make(chan struct{}, 1)
	)

	sess.OnUpdate(func(ev agenttypes.Event) {
		switch ev.Type {
		case agenttypes.EventTypeMessageChunk:
			if chunk, ok := ev.Data.(agenttypes.MessageChunk); ok {
				mu.Lock()
				text.WriteString(chunk.Content)
				mu.Unlock()
			}
		case agenttypes.EventTypeMessageDone:
			mu.Lock()
			gotDone = true
			mu.Unlock()
			select {
			case doneCh <- struct{}{}:
			default:
			}
		}
	})

	prompt := "Reply with EXACT text: " + token + ". No markdown, no explanation."
	if err := sess.SendMessage(ctx, prompt); err != nil {
		return fmt.Errorf("send message: %w", err)
	}

	select {
	case <-doneCh:
	case <-ctx.Done():
		return fmt.Errorf("wait done: %w", ctx.Err())
	}

	mu.Lock()
	defer mu.Unlock()
	if !gotDone {
		return errors.New("done event not received")
	}
	gotText := text.String()
	if !strings.Contains(gotText, token) {
		return fmt.Errorf("response missing token %q: %q", token, gotText)
	}
	return nil
}
