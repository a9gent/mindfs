package codex

import (
	"context"
	"errors"
	"log"
	"strings"
	"sync"

	types "mindfs/server/internal/agent/types"

	codexsdk "github.com/fanwenlin/codex-go-sdk/codex"
)

type OpenOptions struct {
	AgentName  string
	SessionKey string
	Model      string
	Probe      bool
	RootPath   string
	Command    string
	Args       []string
	Env        map[string]string
}

type Runtime struct {
	mu      sync.Mutex
	clients map[string]*codexsdk.Codex
}

func NewRuntime() *Runtime {
	return &Runtime{clients: make(map[string]*codexsdk.Codex)}
}

func (r *Runtime) OpenSession(_ context.Context, opts OpenOptions) (types.Session, error) {
	if opts.SessionKey == "" {
		return nil, errors.New("session key required")
	}
	client := r.getOrCreateClient(opts)
	threadOptions := codexsdk.ThreadOptions{
		Model:            strings.TrimSpace(opts.Model),
		WorkingDirectory: opts.RootPath,
	}
	if !opts.Probe {
		threadOptions.SandboxMode = codexsdk.SandboxModeWorkspaceWrite
		// CLI mode should work for non-git workspaces too.
		threadOptions.SkipGitRepoCheck = true
		threadOptions.ApprovalPolicy = codexsdk.ApprovalModeNever
		threadOptions.ApprovalHandler = func(_ codexsdk.ApprovalRequest) (codexsdk.ApprovalDecision, error) {
			return codexsdk.ApprovalDecisionApproved, nil
		}
	}

	thread := client.StartThread(threadOptions)

	threadID := ""
	if id := thread.ID(); id != nil && strings.TrimSpace(*id) != "" {
		threadID = strings.TrimSpace(*id)
	}
	return &session{
		client:     client,
		thread:     thread,
		threadID:   threadID,
		sessionKey: opts.SessionKey,
	}, nil
}

func (r *Runtime) CloseAll() {
	r.mu.Lock()
	r.clients = make(map[string]*codexsdk.Codex)
	r.mu.Unlock()
}

func (r *Runtime) getOrCreateClient(opts OpenOptions) *codexsdk.Codex {
	if opts.Probe {
		codexOptions := codexsdk.CodexOptions{
			Transport:             codexsdk.TransportAppServer,
			AppServerPathOverride: opts.Command,
			Env:                   opts.Env,
			Verbose:               true,
		}
		if len(opts.Args) > 0 {
			codexOptions.AppServerArgs = append([]string{}, opts.Args...)
		}
		return codexsdk.NewCodex(codexOptions)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if client, ok := r.clients[opts.AgentName]; ok {
		return client
	}
	codexOptions := codexsdk.CodexOptions{
		Transport:         codexsdk.TransportCLI,
		CodexPathOverride: opts.Command,
		Env:               opts.Env,
		Verbose:           true,
	}
	client := codexsdk.NewCodex(codexOptions)
	r.clients[opts.AgentName] = client
	return client
}

type session struct {
	client     *codexsdk.Codex
	thread     *codexsdk.Thread
	threadID   string
	sessionKey string

	mu       sync.RWMutex
	onUpdate func(types.Event)
	turn     types.TurnCanceler
}

func (s *session) SendMessage(ctx context.Context, content string) error {
	if s == nil || s.thread == nil {
		return errors.New("codex session not initialized")
	}
	turnCtx, turnID := s.turn.Begin(ctx)
	defer s.turn.End(turnID)
	log.Printf("[agent/codex] input session=%s thread_id=%s chars=%d content=%q", s.sessionKey, s.SessionID(), len(content), preview(content))
	streamed, err := s.thread.RunStreamed(content, codexsdk.TurnOptions{Context: turnCtx})
	if err != nil {
		log.Printf("[agent/codex] send.error session=%s thread_id=%s err=%v", s.sessionKey, s.SessionID(), err)
		return err
	}

	textByID := map[string]string{}
	for event := range streamed.Events {
		switch e := event.(type) {
		case *codexsdk.ThreadStartedEvent:
			s.setThreadID(e.ThreadId)
		case *codexsdk.ItemStartedEvent:
			if toolCall, ok := mapToolItem(e.Item, true); ok {
				s.emitTool(types.EventTypeToolCall, toolCall)
			}
		case *codexsdk.ItemUpdatedEvent:
			if toolCall, ok := mapToolItem(e.Item, false); ok {
				s.emitTool(types.EventTypeToolUpdate, toolCall)
				continue
			}
			msg, ok := e.Item.(*codexsdk.AgentMessageItem)
			if !ok {
				continue
			}
			s.emitMessageDelta(msg, textByID)
		case *codexsdk.ItemCompletedEvent:
			if toolCall, ok := mapToolItem(e.Item, false); ok {
				s.emitTool(types.EventTypeToolUpdate, toolCall)
				continue
			}
			msg, ok := e.Item.(*codexsdk.AgentMessageItem)
			if ok {
				s.emitMessageDelta(msg, textByID)
				continue
			}
			if thought, ok := e.Item.(*codexsdk.ReasoningItem); ok {
				summary := strings.TrimSpace(strings.Join(thought.Summary, "\n"))
				if summary != "" {
					log.Printf("[agent/codex] output.thought session=%s thread_id=%s chars=%d content=%q", s.sessionKey, s.SessionID(), len(summary), preview(summary))
					s.emit(types.Event{Type: types.EventTypeThoughtChunk, SessionID: s.SessionID(), Data: types.ThoughtChunk{Content: summary}})
				}
			}
		case *codexsdk.TurnCompletedEvent:
			s.updateThreadIDFromThread()
			log.Printf("[agent/codex] output.done session=%s thread_id=%s", s.sessionKey, s.SessionID())
			s.emit(types.Event{Type: types.EventTypeMessageDone, SessionID: s.SessionID()})
		case *codexsdk.TurnFailedEvent:
			log.Printf("[agent/codex] send.error session=%s thread_id=%s err=%s", s.sessionKey, s.SessionID(), e.Error.Message)
			return errors.New("codex turn failed: " + e.Error.Message)
		case *codexsdk.ThreadErrorEvent:
			log.Printf("[agent/codex] send.error session=%s thread_id=%s err=%s", s.sessionKey, s.SessionID(), e.Message)
			return errors.New("codex thread error: " + e.Message)
		}
	}

	s.updateThreadIDFromThread()
	return nil
}

func (s *session) ListModels(ctx context.Context) (types.ModelList, error) {
	if s == nil || s.client == nil {
		return types.ModelList{}, errors.New("codex session not initialized")
	}
	resp, err := s.client.ListModels(ctx, codexsdk.ModelListParams{})
	if err != nil {
		return types.ModelList{}, err
	}
	models := make([]types.ModelInfo, 0, len(resp.Data))
	currentModelID := ""
	for _, model := range resp.Data {
		name := strings.TrimSpace(model.DisplayName)
		if name == "" {
			name = strings.TrimSpace(model.Model)
		}
		models = append(models, types.ModelInfo{
			ID:          model.Model,
			Name:        name,
			Description: model.Description,
			Hidden:      model.Hidden,
		})
		if model.IsDefault && currentModelID == "" {
			currentModelID = model.Model
		}
	}
	return types.ModelList{
		CurrentModelID: currentModelID,
		Models:         models,
	}, nil
}

func (s *session) emitMessageDelta(msg *codexsdk.AgentMessageItem, textByID map[string]string) {
	delta := messageDelta(textByID[msg.ID], msg.Text)
	textByID[msg.ID] = msg.Text
	if delta == "" {
		return
	}
	log.Printf("[agent/codex] output.chunk session=%s thread_id=%s chars=%d content=%q", s.sessionKey, s.SessionID(), len(delta), preview(delta))
	s.emit(types.Event{Type: types.EventTypeMessageChunk, SessionID: s.SessionID(), Data: types.MessageChunk{Content: delta}})
}

func (s *session) emitTool(eventType types.EventType, toolCall types.ToolCall) {
	logLabel := "output.tool_update"
	if eventType == types.EventTypeToolCall {
		logLabel = "output.tool_call"
	}
	log.Printf("[agent/codex] %s session=%s thread_id=%s tool=%s status=%s", logLabel, s.sessionKey, s.SessionID(), toolCallLabel(toolCall), toolCall.Status)
	s.emit(types.Event{Type: eventType, SessionID: s.SessionID(), Data: toolCall})
}

func (s *session) emit(event types.Event) {
	s.mu.RLock()
	handler := s.onUpdate
	s.mu.RUnlock()
	if handler == nil {
		return
	}
	handler(event)
}

func (s *session) OnUpdate(onUpdate func(types.Event)) {
	s.mu.Lock()
	s.onUpdate = onUpdate
	s.mu.Unlock()
}

func (s *session) CancelCurrentTurn() error {
	s.turn.Cancel()
	return nil
}

func (s *session) SessionID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.threadID
}

func (s *session) Close() error { return nil }

func (s *session) updateThreadIDFromThread() {
	if s == nil || s.thread == nil {
		return
	}
	id := s.thread.ID()
	if id == nil {
		return
	}
	s.setThreadID(*id)
}

func (s *session) setThreadID(id string) {
	if strings.TrimSpace(id) == "" {
		return
	}
	s.mu.Lock()
	s.threadID = id
	s.mu.Unlock()
}

func messageDelta(prev, next string) string {
	if next == "" {
		return ""
	}
	if prev == "" {
		return next
	}
	if strings.HasPrefix(next, prev) {
		return next[len(prev):]
	}
	return next
}

func mapToolItem(item codexsdk.ThreadItem, started bool) (types.ToolCall, bool) {
	switch v := item.(type) {
	case *codexsdk.CommandExecutionItem:
		status := normalizeStatus(string(v.Status), started)
		content := []types.ToolCallContentItem{}
		if v.AggregatedOutput != nil && strings.TrimSpace(*v.AggregatedOutput) != "" {
			content = append(content, types.ToolCallContentItem{Type: "text", Text: *v.AggregatedOutput})
		}
		meta := map[string]any{
			"rawType": "commandExecution",
			"command": v.Command,
		}
		if v.ExitCode != nil {
			meta["exitCode"] = *v.ExitCode
		}
		return types.ToolCall{
			CallID:  v.ID,
			Title:   firstNonEmpty(v.Command, "command"),
			Status:  status,
			Kind:    types.ToolKindExecute,
			Content: content,
			RawType: "commandExecution",
			Meta:    meta,
		}, true
	case *codexsdk.FileChangeItem:
		status := normalizeStatus(string(v.Status), started)
		locations := make([]types.ToolCallLocation, 0, len(v.Changes))
		for _, change := range v.Changes {
			if strings.TrimSpace(change.Path) == "" {
				continue
			}
			locations = append(locations, types.ToolCallLocation{Path: change.Path})
		}
		content := []types.ToolCallContentItem{}
		if strings.TrimSpace(v.Output) != "" {
			content = append(content, types.ToolCallContentItem{Type: "text", Text: v.Output})
		}
		return types.ToolCall{
			CallID:    v.ID,
			Title:     "file_change",
			Status:    status,
			Kind:      types.ToolKindEdit,
			Locations: locations,
			Content:   content,
			RawType:   "fileChange",
		}, true
	case *codexsdk.McpToolCallItem:
		status := normalizeStatus(string(v.Status), started)
		meta := map[string]any{
			"rawType": "mcpToolCall",
			"server":  v.Server,
			"tool":    v.Tool,
		}
		return types.ToolCall{
			CallID:  v.ID,
			Title:   firstNonEmpty(v.Tool, "mcp_tool"),
			Status:  status,
			Kind:    types.ToolKindOther,
			Content: errorContent(v.Error),
			RawType: "mcpToolCall",
			Meta:    meta,
		}, true
	case *codexsdk.CollabToolCallItem:
		status := normalizeStatus(v.Status, started)
		return types.ToolCall{
			CallID:  v.ID,
			Title:   firstNonEmpty(v.Tool, "collab_tool"),
			Status:  status,
			Kind:    types.ToolKindOther,
			Content: errorContent(v.Error),
			RawType: "collabToolCall",
		}, true
	default:
		return types.ToolCall{}, false
	}
}

func errorContent(err *codexsdk.McpToolCallError) []types.ToolCallContentItem {
	if err == nil || strings.TrimSpace(err.Message) == "" {
		return []types.ToolCallContentItem{}
	}
	return []types.ToolCallContentItem{{Type: "text", Text: err.Message}}
}

func normalizeStatus(status string, started bool) string {
	s := strings.ToLower(strings.TrimSpace(status))
	switch s {
	case "inprogress", "in_progress", "running", "pending":
		return "running"
	case "completed", "complete", "success":
		return "complete"
	case "failed", "error", "declined":
		return "failed"
	case "":
		if started {
			return "running"
		}
		return "complete"
	default:
		return s
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func preview(content string) string {
	trimmed := strings.TrimSpace(content)
	if len(trimmed) <= 300 {
		return trimmed
	}
	return trimmed[:300] + "...(truncated)"
}

func toolCallLabel(tc types.ToolCall) string {
	if strings.TrimSpace(tc.Title) != "" {
		return tc.Title
	}
	if strings.TrimSpace(string(tc.Kind)) != "" {
		return string(tc.Kind)
	}
	return "tool"
}
