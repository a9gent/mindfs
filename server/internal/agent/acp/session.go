package acp

import (
	"context"
	"errors"
	"sync"

	acpsdk "github.com/coder/acp-go-sdk"
	types "mindfs/server/internal/agent/types"
)

type OpenOptions struct {
	AgentName  string
	SessionKey string
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
}

func NewRuntime(processCtx context.Context) *Runtime {
	return &Runtime{
		processCtx: processCtx,
		processes:  make(map[string]*Process),
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
	return &session{proc: proc, sessionKey: opts.SessionKey}, nil
}

func (r *Runtime) CloseSession(sessionKey string) {
	for _, proc := range r.listProcesses() {
		proc.CloseSession(sessionKey)
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
