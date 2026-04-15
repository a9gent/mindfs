package codex

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"

	"mindfs/server/internal/agent/logs"
	types "mindfs/server/internal/agent/types"

	codexsdk "github.com/fanwenlin/codex-go-sdk/codex"
)

type OpenOptions struct {
	AgentName       string
	SessionKey      string
	Model           string
	Effort          string
	Probe           bool
	RootPath        string
	Command         string
	Args            []string
	Env             map[string]string
	ResumeSessionID string
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
		Model:                strings.TrimSpace(opts.Model),
		ModelReasoningEffort: codexsdk.ModelReasoningEffort(strings.TrimSpace(opts.Effort)),
		SandboxMode:          codexsdk.SandboxModeFullAccess,
		WorkingDirectory:     opts.RootPath,
		ApprovalPolicy:       codexsdk.ApprovalModeNever,
		ApprovalHandler: func(_ codexsdk.ApprovalRequest) (codexsdk.ApprovalDecision, error) {
			return codexsdk.ApprovalDecisionApproved, nil
		},
	}

	var thread *codexsdk.Thread
	if strings.TrimSpace(opts.ResumeSessionID) != "" {
		thread = client.ResumeThread(strings.TrimSpace(opts.ResumeSessionID), threadOptions)
	} else {
		thread = client.StartThread(threadOptions)
	}

	threadID := ""
	if strings.TrimSpace(opts.ResumeSessionID) != "" {
		threadID = strings.TrimSpace(opts.ResumeSessionID)
	} else if id := thread.ID(); id != nil && strings.TrimSpace(*id) != "" {
		threadID = strings.TrimSpace(*id)
	}
	return &session{
		client:        client,
		thread:        thread,
		threadOpts:    threadOptions,
		threadID:      threadID,
		sessionKey:    opts.SessionKey,
		agentDebugLog: logs.NewAgentLogger(opts.RootPath, opts.SessionKey, opts.AgentName),
	}, nil
}

func (r *Runtime) CloseAll() {
	r.mu.Lock()
	clients := r.clients
	r.clients = make(map[string]*codexsdk.Codex)
	r.mu.Unlock()

	for _, client := range clients {
		if client != nil {
			_ = client.Close()
		}
	}
}

func (r *Runtime) Close(agentName string) error {
	r.mu.Lock()
	client, ok := r.clients[agentName]
	if ok {
		delete(r.clients, agentName)
	}
	r.mu.Unlock()

	if !ok || client == nil {
		return nil
	}
	return client.Close()
}

func (r *Runtime) getOrCreateClient(opts OpenOptions) *codexsdk.Codex {
	r.mu.Lock()
	defer r.mu.Unlock()
	if client, ok := r.clients[opts.AgentName]; ok {
		return client
	}
	client := newClient(opts)
	r.clients[opts.AgentName] = client
	return client
}

func newClient(opts OpenOptions) *codexsdk.Codex {
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

type session struct {
	client     *codexsdk.Codex
	thread     *codexsdk.Thread
	threadOpts codexsdk.ThreadOptions
	threadID   string
	sessionKey string

	mu       sync.RWMutex
	onUpdate func(types.Event)
	turn     types.TurnCanceler

	agentDebugLog *logs.AgentLogger
}

func (s *session) SendMessage(ctx context.Context, content string) error {
	if s == nil || s.thread == nil {
		return errors.New("codex session not initialized")
	}
	turnCtx, turnID := s.turn.Begin(ctx)
	defer s.turn.End(turnID)
	log.Printf("[agent/codex] input session=%s content=%q", s.sessionKey, preview(content))
	streamed, err := s.thread.RunStreamed(content, codexsdk.TurnOptions{Context: turnCtx})
	if err != nil {
		log.Printf("[agent/codex] send.error session=%s err=%v", s.sessionKey, err)
		return err
	}

	textByID := map[string]string{}
	for event := range streamed.Events {
		raw, _ := json.Marshal(event)
		switch e := event.(type) {
		case *codexsdk.ThreadStartedEvent:
			s.setThreadID(e.ThreadId)
		case *codexsdk.ItemStartedEvent:
			s.logRawToolItem(e.Item)
			if toolCall, ok := mapToolItem(e.Item, true); ok {
				s.emit(types.Event{Type: types.EventTypeToolCall, SessionID: s.SessionID(), Data: toolCall})
				continue
			}
			logUnhandledEvent(s.sessionKey, "item.started", raw)
		case *codexsdk.ItemUpdatedEvent:
			s.logRawToolItem(e.Item)
			if toolCall, ok := mapToolItem(e.Item, false); ok {
				s.emit(types.Event{Type: types.EventTypeToolUpdate, SessionID: s.SessionID(), Data: toolCall})
				continue
			}
			msg, ok := e.Item.(*codexsdk.AgentMessageItem)
			if !ok {
				logUnhandledEvent(s.sessionKey, "item.updated", raw)
				continue
			}
			s.emitMessageDelta(msg, textByID)
		case *codexsdk.ItemCompletedEvent:
			s.logRawToolItem(e.Item)
			if toolCall, ok := mapToolItem(e.Item, false); ok {
				s.emit(types.Event{Type: types.EventTypeToolUpdate, SessionID: s.SessionID(), Data: toolCall})
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
					s.emit(types.Event{Type: types.EventTypeThoughtChunk, SessionID: s.SessionID(), Data: types.ThoughtChunk{Content: summary}})
				}
				continue
			}
			logUnhandledEvent(s.sessionKey, "item.completed", raw)
		case *codexsdk.TurnCompletedEvent:
			s.updateThreadIDFromThread()
			log.Printf("[agent/codex] output.done session=%s", s.sessionKey)
			s.emit(types.Event{Type: types.EventTypeMessageDone, SessionID: s.SessionID()})
		case *codexsdk.TurnFailedEvent:
			log.Printf("[agent/codex] send.error session=%s err=%s", s.sessionKey, e.Error.Message)
			return errors.New("codex turn failed: " + e.Error.Message)
		case *codexsdk.ThreadErrorEvent:
			log.Printf("[agent/codex] send.error session=%s err=%s", s.sessionKey, e.Message)
			return errors.New("codex thread error: " + e.Message)
		default:
			logUnhandledEvent(s.sessionKey, "event", raw)
		}
	}

	s.updateThreadIDFromThread()
	return nil
}

func (s *session) SetModel(_ context.Context, model string) error {
	if s == nil || s.client == nil {
		return errors.New("codex session not initialized")
	}
	threadID := strings.TrimSpace(s.SessionID())
	if threadID == "" {
		s.updateThreadIDFromThread()
		threadID = strings.TrimSpace(s.SessionID())
	}
	if threadID == "" {
		return errors.New("codex thread id unavailable")
	}
	opts := s.threadOpts
	opts.Model = strings.TrimSpace(model)
	thread := s.client.ResumeThread(threadID, opts)
	s.mu.Lock()
	s.thread = thread
	s.threadOpts = opts
	s.threadID = threadID
	s.mu.Unlock()
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
			ID:            model.Model,
			Name:          name,
			Description:   model.Description,
			Hidden:        model.Hidden,
			SupportEffort: true,
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

func (s *session) SetMode(_ context.Context, _ string) error {
	return nil
}

func (s *session) ListModes(_ context.Context) (types.ModeList, error) {
	return types.ModeList{}, nil
}

func (s *session) ListCommands(ctx context.Context) (types.CommandList, error) {
	_ = ctx
	if s == nil || s.client == nil {
		return types.CommandList{}, errors.New("codex session not initialized")
	}
	supported := s.client.SupportedSlashCommands()
	commands := make([]types.CommandInfo, 0, len(supported))
	for _, command := range supported {
		name := strings.TrimSpace(command.Name)
		if name == "" {
			continue
		}
		commands = append(commands, types.CommandInfo{
			Name:         name,
			Description:  strings.TrimSpace(command.Description),
			ArgumentHint: strings.TrimSpace(command.ArgumentHint),
		})
	}
	log.Printf("[agent/codex] commands.cached session=%s count=%d", s.sessionKey, len(commands))
	return types.CommandList{Commands: commands}, nil
}

func (s *session) emitMessageDelta(msg *codexsdk.AgentMessageItem, textByID map[string]string) {
	delta := messageDelta(textByID[msg.ID], msg.Text)
	textByID[msg.ID] = msg.Text
	if delta == "" {
		return
	}
	s.emit(types.Event{Type: types.EventTypeMessageChunk, SessionID: s.SessionID(), Data: types.MessageChunk{Content: delta}})
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

func (s *session) logRawToolItem(item codexsdk.ThreadItem) {
	if s == nil || s.agentDebugLog == nil || !isToolItem(item) {
		return
	}
	raw, err := json.Marshal(item)
	if err != nil {
		return
	}
	s.agentDebugLog.AppendRaw(raw)
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
		content := []types.ToolCallContentItem{}
		for _, change := range v.Changes {
			if strings.TrimSpace(change.Path) == "" {
				continue
			}
			locations = append(locations, types.ToolCallLocation{Path: change.Path})
			if strings.TrimSpace(change.Diff) != "" {
				content = append(content, types.ToolCallContentItem{
					Type:       "text",
					Text:       change.Diff,
					Path:       change.Path,
					ChangeKind: string(change.Kind.Type),
				})
			}
		}
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

func isToolItem(item codexsdk.ThreadItem) bool {
	switch item.(type) {
	case *codexsdk.CommandExecutionItem, *codexsdk.FileChangeItem, *codexsdk.McpToolCallItem, *codexsdk.CollabToolCallItem:
		return true
	default:
		return false
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

func logUnhandledEvent(sessionKey, scope string, raw []byte) {
	const maxRawLogBytes = 1024
	if len(raw) > maxRawLogBytes {
		raw = append(raw[:maxRawLogBytes], []byte("...(truncated)")...)
	}
	log.Printf("[agent/codex] unhandled.%s raw=%s", scope, string(raw))
}
