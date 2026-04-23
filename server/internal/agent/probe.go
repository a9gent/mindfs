package agent

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
)

type Status struct {
	Name           string                   `json:"name"`
	Installed      bool                     `json:"installed"`
	Available      bool                     `json:"available"`
	Version        string                   `json:"version,omitempty"`
	Error          string                   `json:"error,omitempty"`
	RuntimeError   string                   `json:"-"`
	ProbeError     string                   `json:"-"`
	LastProbe      time.Time                `json:"last_probe"`
	CurrentModelID string                   `json:"current_model_id,omitempty"`
	CurrentModeID  string                   `json:"current_mode_id,omitempty"`
	DefaultModelID string                   `json:"default_model_id,omitempty"`
	DefaultEffort  string                   `json:"default_effort,omitempty"`
	Efforts        []string                 `json:"efforts,omitempty"`
	Models         []agenttypes.ModelInfo   `json:"models,omitempty"`
	Modes          []agenttypes.ModeInfo    `json:"modes"`
	ModelsError    string                   `json:"models_error,omitempty"`
	ModesError     string                   `json:"modes_error,omitempty"`
	Commands       []agenttypes.CommandInfo `json:"commands,omitempty"`
	CommandsError  string                   `json:"commands_error,omitempty"`
}

const (
	probeSessionTimeout     = 45 * time.Second
	probeInteractionTimeout = 3 * time.Minute
	probeModelListTimeout   = 30 * time.Second
	probeCommandListTimeout = 30 * time.Second
)

type probePhase string

const (
	probePhaseInitial    probePhase = "initial"
	probePhaseBackground probePhase = "background"
)

// Prober 管理 Agent 可用性探测
type Prober struct {
	cfg           *Config
	pool          *Pool
	statuses      map[string]Status
	mu            sync.RWMutex
	inFlight      map[string]struct{} // per-agent probe 去重，mu 保护
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
		inFlight:      make(map[string]struct{}),
		probeInterval: probeInterval,
		stopCh:        make(chan struct{}),
	}
	// Seed configured agents so API can return stable list before first probe completes.
	if cfg != nil {
		now := time.Now().UTC()
		for _, def := range cfg.Agents {
			p.statuses[def.Name] = normalizeStatus(probeInstallStatus(def.Name, def, now))
		}
	}
	return p
}

// Start 启动定期探测
func (p *Prober) Start(ctx context.Context) {
	// 首次全量探测放到后台，避免阻塞服务启动和请求处理。
	go p.ProbeAll(ctx)

	// 启动定期探测：分别重试未安装命令和已安装但不可用的 Agent。
	ticker := time.NewTicker(p.probeInterval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				p.probeMissingCommands()
				p.probeFailedInstalledOnly(ctx)
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
func (p *Prober) ProbeAll(ctx context.Context) {
	if p.cfg == nil {
		return
	}
	p.probeConfiguredAgents(ctx, p.cfg.Agents)
}

// ReportRuntimeFailure marks an agent as unavailable due to a real user-facing runtime failure.
func (p *Prober) ReportRuntimeFailure(name string, err error) {
	msg := "unknown failure"
	if err != nil {
		msg = err.Error()
	}
	installed := true
	current, ok := p.GetStatus(name)
	if ok {
		installed = current.Installed
	}
	status := unavailableStatus(name, installed, current.ProbeError, time.Now().UTC())
	status.RuntimeError = msg
	p.setStatus(status)
}

// ReportProbeFailure marks an agent as unavailable due to background probe failure.
func (p *Prober) ReportProbeFailure(name string, err error) {
	msg := "unknown failure"
	if err != nil {
		msg = err.Error()
	}
	installed := true
	current, ok := p.GetStatus(name)
	if ok {
		installed = current.Installed
	}
	status := unavailableStatus(name, installed, msg, time.Now().UTC())
	status.RuntimeError = current.RuntimeError
	p.setStatus(status)
}

// ReportSuccess marks an agent as available due to successful runtime interaction.
func (p *Prober) ReportSuccess(name string) {
	st, _ := p.GetStatus(name)
	st.Name = name
	st.Installed = true
	st.Available = true
	st.Error = ""
	st.RuntimeError = ""
	st.ProbeError = ""
	st.LastProbe = time.Now().UTC()
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

// GetInstalledStatuses returns configured statuses filtered to installed agents.
func (p *Prober) GetInstalledStatuses() []Status {
	all := p.GetAllStatuses()
	filtered := make([]Status, 0, len(all))
	for _, st := range all {
		if !st.Installed {
			continue
		}
		filtered = append(filtered, st)
	}
	return filtered
}

// IsAvailable 检查 Agent 是否可用
func (p *Prober) IsAvailable(name string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	status, ok := p.statuses[name]
	return ok && status.Available
}

func probeConfiguredAgentWithPool(ctx context.Context, name string, def Definition, pool *Pool) Status {
	status := probeInstallStatus(name, def, time.Now().UTC())
	if !status.Installed {
		return status
	}
	return probeInstalledAgentWithPool(ctx, name, def, pool, status, probePhaseInitial)
}

func probeInstalledAgentWithPool(ctx context.Context, name string, def Definition, pool *Pool, status Status, phase probePhase) Status {
	status.Installed = true

	tmpRoot, err := EnsureStableWorkDir("agent-probe", name)
	if err != nil {
		status.ProbeError = err.Error()
		return status
	}

	pool, ownsPool := resolveProbePool(def, pool)
	if ownsPool {
		defer pool.CloseAll()
	}

	sessionKey := fmt.Sprintf(
		"probe-%s-%s",
		name,
		time.Now().UTC().Format("20060102-150405"),
	)
	defer pool.Close(sessionKey)
	openCtx := ctx
	sessionCancel := func() {}
	if phase == probePhaseInitial {
		openCtx, sessionCancel = context.WithTimeout(ctx, probeSessionTimeout)
	}
	defer sessionCancel()
	sess, err := pool.GetOrCreate(openCtx, agenttypes.OpenSessionInput{
		SessionKey: sessionKey,
		AgentName:  name,
		Probe:      true,
		RootPath:   tmpRoot,
	})
	if err != nil {
		status.ProbeError = err.Error()
		return status
	}

	interactionCtx := ctx
	interactionCancel := func() {}
	if phase == probePhaseInitial {
		interactionCtx, interactionCancel = context.WithTimeout(ctx, probeInteractionTimeout)
	}
	defer interactionCancel()
	if err := VerifySessionInteraction(interactionCtx, sess); err != nil {
		if hint, ok := pool.KillAgentProcess(name, 750*time.Millisecond); ok {
			status.ProbeError = hint
			return status
		}
		status.ProbeError = err.Error()
		return status
	}

	status.Available = true
	status.Error = ""
	status.ProbeError = ""
	populateProbeModels(ctx, sess, &status)
	populateProbeCommands(ctx, sess, &status)
	return status
}

func (p *Prober) probeMissingCommands() {
	if p.cfg == nil {
		return
	}
	defs := p.collectDefinitions(func(st Status, ok bool) bool {
		return !ok || !st.Installed
	})
	log.Printf("[agent/probe] probe_missing_commands count=%d agents=%s", len(defs), definitionNames(defs))
	p.probeInstallOnly(defs)
}

func (p *Prober) probeFailedInstalledOnly(ctx context.Context) {
	if p.cfg == nil {
		return
	}
	defs := p.collectDefinitions(func(st Status, ok bool) bool {
		return ok && st.Installed && !st.Available
	})
	log.Printf("[agent/probe] probe_failed_installed count=%d agents=%s", len(defs), definitionNames(defs))
	p.probeInstalledAgents(ctx, defs)
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
	if prev.Installed != next.Installed {
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
	if prev.RuntimeError != next.RuntimeError {
		return true
	}
	if prev.ProbeError != next.ProbeError {
		return true
	}
	if prev.CurrentModelID != next.CurrentModelID {
		return true
	}
	if prev.CurrentModeID != next.CurrentModeID {
		return true
	}
	if len(prev.Efforts) != len(next.Efforts) {
		return true
	}
	for i := range prev.Efforts {
		if prev.Efforts[i] != next.Efforts[i] {
			return true
		}
	}
	if prev.ModelsError != next.ModelsError {
		return true
	}
	if prev.ModesError != next.ModesError {
		return true
	}
	if prev.CommandsError != next.CommandsError {
		return true
	}
	if len(prev.Models) != len(next.Models) {
		return true
	}
	for i := range prev.Models {
		if prev.Models[i].ID != next.Models[i].ID ||
			prev.Models[i].Name != next.Models[i].Name ||
			prev.Models[i].Description != next.Models[i].Description ||
			prev.Models[i].Hidden != next.Models[i].Hidden ||
			prev.Models[i].SupportEffort != next.Models[i].SupportEffort {
			return true
		}
	}
	if len(prev.Modes) != len(next.Modes) {
		return true
	}
	for i := range prev.Modes {
		if prev.Modes[i] != next.Modes[i] {
			return true
		}
	}
	if len(prev.Commands) != len(next.Commands) {
		return true
	}
	for i := range prev.Commands {
		if prev.Commands[i] != next.Commands[i] {
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

func unavailableStatus(name string, installed bool, errMsg string, ts time.Time) Status {
	return Status{
		Name:       name,
		Installed:  installed,
		Available:  false,
		Error:      errMsg,
		ProbeError: errMsg,
		LastProbe:  ts,
	}
}

func probeInstallStatus(name string, def Definition, ts time.Time) Status {
	status := unavailableStatus(name, false, "", ts)
	if def.Command == "" {
		status.ProbeError = "command required"
		return status
	}
	if _, err := exec.LookPath(def.Command); err != nil {
		status.ProbeError = err.Error()
		return status
	}
	status.Installed = true
	status.ProbeError = "probe pending"
	return status
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
	status.Efforts = inferAgentEfforts(models.Models)

	modes, err := sess.ListModes(modelsCtx)
	if err != nil {
		status.ModesError = err.Error()
		return
	}
	status.CurrentModeID = modes.CurrentModeID
	status.Modes = modes.Modes
}

func populateProbeCommands(ctx context.Context, sess agenttypes.Session, status *Status) {
	commandsCtx, commandsCancel := context.WithTimeout(ctx, probeCommandListTimeout)
	defer commandsCancel()

	commands, err := sess.ListCommands(commandsCtx)
	if err != nil {
		status.CommandsError = err.Error()
		return
	}
	status.Commands = commands.Commands
}

func normalizeStatus(status Status) Status {
	status.RuntimeError = strings.TrimSpace(status.RuntimeError)
	status.ProbeError = strings.TrimSpace(status.ProbeError)
	switch {
	case status.RuntimeError != "":
		status.Error = status.RuntimeError
	case status.ProbeError != "":
		status.Error = status.ProbeError
	default:
		status.Error = strings.TrimSpace(status.Error)
	}
	if status.Available {
		return status
	}
	status.CurrentModelID = ""
	status.CurrentModeID = ""
	status.Efforts = nil
	status.Models = nil
	status.Modes = nil
	status.ModelsError = ""
	status.ModesError = ""
	status.Commands = nil
	status.CommandsError = ""
	return status
}

func inferAgentEfforts(models []agenttypes.ModelInfo) []string {
	hasSupport := false
	looksLikeClaude := false
	for _, model := range models {
		if !model.SupportEffort {
			continue
		}
		hasSupport = true
		joined := strings.ToLower(strings.TrimSpace(model.ID) + " " + strings.TrimSpace(model.Name))
		if strings.Contains(joined, "sonnet") || strings.Contains(joined, "opus") {
			looksLikeClaude = true
		}
	}
	if !hasSupport {
		return nil
	}
	if looksLikeClaude {
		return []string{"low", "medium", "high"}
	}
	return []string{"low", "medium", "high", "xhigh"}
}

func (p *Prober) collectDefinitions(include func(Status, bool) bool) []Definition {
	defs := make([]Definition, 0, len(p.cfg.Agents))
	for _, def := range p.cfg.Agents {
		status, ok := p.GetStatus(def.Name)
		if !include(status, ok) {
			continue
		}
		defs = append(defs, def)
	}
	return defs
}

func (p *Prober) probeConfiguredAgents(ctx context.Context, defs []Definition) {
	if len(defs) == 0 {
		return
	}
	p.runDefinitionsConcurrently(defs, func(_ int, def Definition) {
		status := probeConfiguredAgentWithPool(ctx, def.Name, def, p.pool)
		p.setStatus(status)
	})
}

func (p *Prober) probeInstallOnly(defs []Definition) {
	if len(defs) == 0 {
		return
	}

	p.runDefinitionsConcurrently(defs, func(_ int, def Definition) {
		status := probeInstallStatus(def.Name, def, time.Now().UTC())
		p.setStatus(status)
	})
}

func (p *Prober) probeInstalledAgents(ctx context.Context, defs []Definition) {
	if len(defs) == 0 {
		return
	}

	p.runDefinitionsConcurrently(defs, func(_ int, def Definition) {
		status := probeInstalledAgentWithPool(ctx, def.Name, def, p.pool, probeInstallStatus(def.Name, def, time.Now().UTC()), probePhaseBackground)
		p.setStatus(status)
	})
}

func (p *Prober) runDefinitionsConcurrently(defs []Definition, fn func(i int, def Definition)) {
	for i, def := range defs {
		p.mu.Lock()
		if _, running := p.inFlight[def.Name]; running {
			p.mu.Unlock()
			continue
		}
		p.inFlight[def.Name] = struct{}{}
		p.mu.Unlock()

		go func(i int, def Definition) {
			defer func() {
				p.mu.Lock()
				delete(p.inFlight, def.Name)
				p.mu.Unlock()
			}()
			fn(i, def)
		}(i, def)
	}
}

func definitionNames(defs []Definition) string {
	if len(defs) == 0 {
		return "-"
	}
	names := make([]string, 0, len(defs))
	for _, def := range defs {
		names = append(names, def.Name)
	}
	return strings.Join(names, ",")
}

// VerifySessionInteraction sends a deterministic ping prompt and verifies the response contains the token.
func VerifySessionInteraction(ctx context.Context, sess agenttypes.Session) error {
	if sess == nil {
		return errors.New("session required")
	}

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

	if err := sess.SendMessage(ctx, "hello"); err != nil {
		return err
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
	gotText := strings.TrimSpace(text.String())
	if gotText == "" {
		return errors.New("response was empty")
	}
	return nil
}
