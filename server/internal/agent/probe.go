package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type Status struct {
	Name      string    `json:"name"`
	Available bool      `json:"available"`
	Version   string    `json:"version,omitempty"`
	Error     string    `json:"error,omitempty"`
	LastProbe time.Time `json:"last_probe"`
}

// Prober 管理 Agent 可用性探测
type Prober struct {
	cfg           *Config
	statuses      map[string]Status
	mu            sync.RWMutex
	probeInterval time.Duration
	stopCh        chan struct{}
}

func NewProber(cfg *Config, probeInterval time.Duration) *Prober {
	if probeInterval <= 0 {
		probeInterval = 5 * time.Minute
	}
	p := &Prober{
		cfg:           cfg,
		statuses:      make(map[string]Status),
		probeInterval: probeInterval,
		stopCh:        make(chan struct{}),
	}
	// Seed configured agents so API can return stable list before first probe completes.
	if cfg != nil {
		now := time.Now().UTC()
		for name := range cfg.Agents {
			p.statuses[name] = Status{
				Name:      name,
				Available: false,
				Error:     "probing",
				LastProbe: now,
			}
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
	for name, def := range p.cfg.Agents {
		status := ProbeAgent(ctx, name, def)
		statuses = append(statuses, status)

		p.mu.Lock()
		p.statuses[name] = status
		p.mu.Unlock()
	}
	return statuses
}

// ProbeOne 探测单个 Agent 并更新缓存
func (p *Prober) ProbeOne(ctx context.Context, name string) Status {
	if p.cfg == nil {
		return Status{Name: name, Available: false, Error: "config not loaded", LastProbe: time.Now().UTC()}
	}

	def, ok := p.cfg.Agents[name]
	if !ok {
		return Status{Name: name, Available: false, Error: "agent not configured", LastProbe: time.Now().UTC()}
	}

	status := ProbeAgent(ctx, name, def)

	p.mu.Lock()
	p.statuses[name] = status
	p.mu.Unlock()

	return status
}

// ReportFailure marks an agent as unavailable due to runtime interaction/probe failure.
func (p *Prober) ReportFailure(name string, err error) {
	msg := "unknown failure"
	if err != nil {
		msg = err.Error()
	}
	p.mu.Lock()
	p.statuses[name] = Status{
		Name:      name,
		Available: false,
		Error:     msg,
		LastProbe: time.Now().UTC(),
	}
	p.mu.Unlock()
}

// ReportSuccess marks an agent as available due to successful runtime interaction.
func (p *Prober) ReportSuccess(name string) {
	p.mu.Lock()
	st := p.statuses[name]
	st.Name = name
	st.Available = true
	st.Error = ""
	st.LastProbe = time.Now().UTC()
	p.statuses[name] = st
	p.mu.Unlock()
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
	for _, status := range p.statuses {
		statuses = append(statuses, status)
	}
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
	status := Status{Name: name, Available: false, LastProbe: time.Now().UTC()}
	if def.Command == "" {
		status.Error = "command required"
		return status
	}
	if _, err := exec.LookPath(def.Command); err != nil {
		status.Error = err.Error()
		return status
	}

	probeCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()

	tmpRoot, err := os.MkdirTemp("", "mindfs-agent-probe-*")
	if err != nil {
		status.Error = err.Error()
		return status
	}
	defer os.RemoveAll(tmpRoot)

	pool := NewPool(Config{
		Agents: map[string]Definition{
			name: def,
		},
	})
	defer pool.CloseAll()

	sessionKey := "probe-" + time.Now().UTC().Format("20060102-150405")
	sess, err := pool.GetOrCreate(probeCtx, sessionKey, name, tmpRoot)
	if err != nil {
		status.Error = err.Error()
		return status
	}

	if err := VerifySessionInteraction(probeCtx, sess); err != nil {
		status.Error = err.Error()
		return status
	}

	status.Available = true
	return status
}

func (p *Prober) probeFailedOnly(ctx context.Context) {
	if p.cfg == nil {
		return
	}
	for name, def := range p.cfg.Agents {
		p.mu.RLock()
		st, ok := p.statuses[name]
		p.mu.RUnlock()
		if ok && st.Available {
			continue
		}
		status := ProbeAgent(ctx, name, def)
		p.mu.Lock()
		p.statuses[name] = status
		p.mu.Unlock()
	}
}

// VerifySessionInteraction sends a deterministic ping prompt and verifies the response contains the token.
func VerifySessionInteraction(ctx context.Context, sess Session) error {
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

	sess.OnUpdate(func(ev Event) {
		switch ev.Type {
		case EventTypeMessageChunk:
			if chunk, ok := ev.Data.(MessageChunk); ok {
				mu.Lock()
				text.WriteString(chunk.Content)
				mu.Unlock()
			}
		case EventTypeMessageDone:
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
