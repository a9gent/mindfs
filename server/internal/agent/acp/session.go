package acp

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	types "mindfs/server/internal/agent/types"
)

type OpenOptions struct {
	AgentName  string
	SessionKey string
	Model      string
	RootPath   string
	Command    string
	Args       []string
	Env        map[string]string
	Cwd        string
}

type Runtime struct {
	processCtx context.Context
	mu         sync.Mutex
	processes  map[string]*Process
	closeHints map[string]string
}

func NewRuntime(processCtx context.Context) *Runtime {
	return &Runtime{
		processCtx: processCtx,
		processes:  make(map[string]*Process),
		closeHints: make(map[string]string),
	}
}

func (r *Runtime) OpenSession(_ context.Context, opts OpenOptions) (types.Session, error) {
	if opts.SessionKey == "" {
		return nil, errors.New("session key required")
	}
	proc, err := r.getOrCreateProcess(opts)
	if err != nil {
		return nil, err
	}

	if err := proc.NewSession(r.processCtx, opts.SessionKey, opts.RootPath); err != nil {
		return nil, err
	}
	if strings.TrimSpace(opts.Model) != "" {
		if err := proc.SetModel(r.processCtx, opts.SessionKey, opts.Model); err != nil {
			proc.CloseSession(opts.SessionKey)
			return nil, err
		}
	}
	return &session{proc: proc, sessionKey: opts.SessionKey}, nil
}

func mapModelState(state *acpsdk.SessionModelState) types.ModelList {
	if state == nil {
		return types.ModelList{}
	}
	models := make([]types.ModelInfo, 0, len(state.AvailableModels))
	for _, model := range state.AvailableModels {
		description := ""
		if model.Description != nil {
			description = *model.Description
		}
		models = append(models, types.ModelInfo{
			ID:          string(model.ModelId),
			Name:        model.Name,
			Description: description,
		})
	}
	return types.ModelList{
		CurrentModelID: string(state.CurrentModelId),
		Models:         models,
	}
}

func mapCommandState(commands []acpsdk.AvailableCommand) types.CommandList {
	if len(commands) == 0 {
		return types.CommandList{}
	}
	items := make([]types.CommandInfo, 0, len(commands))
	for _, command := range commands {
		argumentHint := ""
		if command.Input != nil && command.Input.Unstructured != nil {
			argumentHint = strings.TrimSpace(command.Input.Unstructured.Hint)
		}
		items = append(items, types.CommandInfo{
			Name:         command.Name,
			Description:  command.Description,
			ArgumentHint: argumentHint,
		})
	}
	return types.CommandList{Commands: items}
}

func (r *Runtime) CloseSession(sessionKey string) {
	for _, proc := range r.listProcesses() {
		proc.CloseSession(sessionKey)
	}
}

func (r *Runtime) Close(agentName string) {
	if strings.TrimSpace(agentName) == "" {
		return
	}
	r.mu.Lock()
	proc := r.processes[agentName]
	delete(r.processes, agentName)
	delete(r.closeHints, agentName)
	r.mu.Unlock()
	if proc != nil {
		_ = proc.Close()
		if hint, ok := waitForRecentStderrHint(proc, 750*time.Millisecond); ok {
			r.mu.Lock()
			r.closeHints[agentName] = hint
			r.mu.Unlock()
		}
	}
}

func (r *Runtime) RecentCloseHint(agentName string) (string, bool) {
	if strings.TrimSpace(agentName) == "" {
		return "", false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	hint, ok := r.closeHints[agentName]
	if !ok || strings.TrimSpace(hint) == "" {
		return "", false
	}
	delete(r.closeHints, agentName)
	return hint, true
}

func waitForRecentStderrHint(proc *Process, wait time.Duration) (string, bool) {
	if proc == nil {
		return "", false
	}
	deadline := time.Now().Add(wait)
	for {
		if hint, ok := proc.RecentStderrHint(); ok {
			return hint, true
		}
		if time.Now().After(deadline) {
			return "", false
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func (r *Runtime) CloseAll() {
	procs := r.listProcessesAndReset()
	for _, proc := range procs {
		proc.Close()
	}
}

func (r *Runtime) listProcesses() []*Process {
	r.mu.Lock()
	defer r.mu.Unlock()
	procs := make([]*Process, 0, len(r.processes))
	for _, proc := range r.processes {
		procs = append(procs, proc)
	}
	return procs
}

func (r *Runtime) listProcessesAndReset() []*Process {
	r.mu.Lock()
	defer r.mu.Unlock()
	procs := make([]*Process, 0, len(r.processes))
	for _, proc := range r.processes {
		procs = append(procs, proc)
	}
	r.processes = make(map[string]*Process)
	return procs
}

func (r *Runtime) getOrCreateProcess(opts OpenOptions) (*Process, error) {
	r.mu.Lock()
	if proc, ok := r.processes[opts.AgentName]; ok {
		r.mu.Unlock()
		return proc, nil
	}
	r.mu.Unlock()

	proc, err := Start(r.processCtx, opts.AgentName, opts.Command, opts.Args, opts.Cwd, opts.Env)
	if err != nil {
		return nil, err
	}

	if err := proc.Initialize(r.processCtx); err != nil {
		proc.Close()
		return nil, err
	}

	r.mu.Lock()
	if existing, ok := r.processes[opts.AgentName]; ok {
		r.mu.Unlock()
		proc.Close()
		return existing, nil
	}
	r.processes[opts.AgentName] = proc
	r.mu.Unlock()
	return proc, nil
}

type session struct {
	proc       *Process
	sessionKey string
}

func (s *session) SendMessage(ctx context.Context, content string) error {
	return s.proc.SendMessage(ctx, s.sessionKey, content)
}

func (s *session) ListModels(_ context.Context) (types.ModelList, error) {
	if s == nil || s.proc == nil {
		return types.ModelList{}, errors.New("acp session not initialized")
	}
	return mapModelState(s.proc.SessionModelState(s.sessionKey)), nil
}

func (s *session) ListCommands(_ context.Context) (types.CommandList, error) {
	if s == nil || s.proc == nil {
		return types.CommandList{}, errors.New("acp session not initialized")
	}
	return mapCommandState(s.proc.SessionCommands(s.sessionKey)), nil
}

func (s *session) CancelCurrentTurn() error {
	return s.proc.CancelCurrentTurn(s.sessionKey)
}

func (s *session) OnUpdate(onUpdate func(types.Event)) {
	s.proc.SetOnUpdate(s.sessionKey, func(update SessionUpdate) {
		if onUpdate != nil {
			onUpdate(convertEvent(update))
		}
	})
}

func (s *session) SessionID() string {
	return s.proc.SessionID(s.sessionKey)
}

func (s *session) Close() error {
	s.proc.CloseSession(s.sessionKey)
	return nil
}

func convertEvent(update SessionUpdate) types.Event {
	ev := types.Event{
		Type:      types.EventType(update.Type),
		SessionID: update.SessionID,
	}
	raw := update.Raw
	switch update.Type {
	case UpdateTypeMessageChunk:
		if raw.AgentMessageChunk != nil && raw.AgentMessageChunk.Content.Text != nil {
			ev.Data = types.MessageChunk{Content: raw.AgentMessageChunk.Content.Text.Text}
		}
	case UpdateTypeThoughtChunk:
		if raw.AgentThoughtChunk != nil && raw.AgentThoughtChunk.Content.Text != nil {
			ev.Data = types.ThoughtChunk{Content: raw.AgentThoughtChunk.Content.Text.Text}
		}
	case UpdateTypeToolCall:
		if raw.ToolCall != nil {
			locations := make([]types.ToolCallLocation, 0, len(raw.ToolCall.Locations))
			for _, loc := range raw.ToolCall.Locations {
				locations = append(locations, types.ToolCallLocation{Path: loc.Path, Line: loc.Line})
			}
			status := "running"
			if raw.ToolCall.Status != "" {
				status = string(raw.ToolCall.Status)
			}
			kind := types.ToolKind(raw.ToolCall.Kind)
			ev.Data = types.ToolCall{
				CallID:    string(raw.ToolCall.ToolCallId),
				Title:     raw.ToolCall.Title,
				Status:    status,
				Kind:      kind,
				Content:   convertToolCallContent(raw.ToolCall.Content),
				Locations: locations,
			}
		}
	case UpdateTypeToolUpdate:
		if raw.ToolCallUpdate != nil {
			status := "complete"
			if raw.ToolCallUpdate.Status != nil && *raw.ToolCallUpdate.Status == acpsdk.ToolCallStatusFailed {
				status = "failed"
			}
			kind := types.ToolKind("")
			if raw.ToolCallUpdate.Kind != nil {
				kind = types.ToolKind(*raw.ToolCallUpdate.Kind)
			}
			name := ""
			if raw.ToolCallUpdate.Title != nil {
				name = *raw.ToolCallUpdate.Title
			}
			locations := make([]types.ToolCallLocation, 0, len(raw.ToolCallUpdate.Locations))
			for _, loc := range raw.ToolCallUpdate.Locations {
				locations = append(locations, types.ToolCallLocation{Path: loc.Path, Line: loc.Line})
			}
			ev.Data = types.ToolCall{
				CallID:    string(raw.ToolCallUpdate.ToolCallId),
				Title:     name,
				Status:    status,
				Kind:      kind,
				Content:   convertToolCallContent(raw.ToolCallUpdate.Content),
				Locations: locations,
			}
		}
	}
	return ev
}

func convertToolCallContent(items []acpsdk.ToolCallContent) []types.ToolCallContentItem {
	if len(items) == 0 {
		return nil
	}
	out := make([]types.ToolCallContentItem, 0, len(items))
	for _, item := range items {
		if item.Content != nil {
			contentItem := types.ToolCallContentItem{Type: "text"}
			block := item.Content.Content
			if block.Text != nil {
				contentItem.Text = block.Text.Text
				out = append(out, contentItem)
			}
			continue
		}
		if item.Diff != nil {
			out = append(out, types.ToolCallContentItem{
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
