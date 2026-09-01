package acp

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/agent/logs"
	types "mindfs/server/internal/agent/types"

	acpsdk "github.com/coder/acp-go-sdk"
)

type OpenOptions struct {
	AgentName       string
	SessionKey      string
	Model           string
	Mode            string
	Effort          string
	RootPath        string
	Command         string
	Args            []string
	Env             map[string]string
	Cwd             string
	ResumeSessionID string
}

type Runtime struct {
	processCtx context.Context
	mu         sync.Mutex
	processes  map[string]*Process
	closeHints map[string]string
	closed     bool
}

func NewRuntime(processCtx context.Context) *Runtime {
	return &Runtime{
		processCtx: processCtx,
		processes:  make(map[string]*Process),
		closeHints: make(map[string]string),
	}
}

func (r *Runtime) OpenSession(ctx context.Context, opts OpenOptions) (types.Session, error) {
	if opts.SessionKey == "" {
		return nil, errors.New("session key required")
	}
	proc, err := r.getOrCreateProcess(opts)
	if err != nil {
		return nil, err
	}

	if strings.TrimSpace(opts.ResumeSessionID) != "" {
		if err := proc.ResumeSession(ctx, opts.SessionKey, opts.ResumeSessionID, opts.Cwd); err != nil {
			return nil, err
		}
	} else {
		if err := proc.NewSession(ctx, opts.SessionKey, opts.RootPath); err != nil {
			return nil, err
		}
	}
	if strings.TrimSpace(opts.Model) != "" {
		if err := proc.SetModel(ctx, opts.SessionKey, opts.Model); err != nil {
			proc.ForgetSession(opts.SessionKey)
			return nil, err
		}
	}
	if strings.TrimSpace(opts.Mode) != "" {
		if err := proc.SetMode(ctx, opts.SessionKey, opts.Mode); err != nil {
			proc.ForgetSession(opts.SessionKey)
			return nil, err
		}
	}
	if strings.TrimSpace(opts.Effort) != "" {
		if err := proc.SetThoughtLevel(ctx, opts.SessionKey, opts.Effort); err != nil {
			proc.ForgetSession(opts.SessionKey)
			return nil, err
		}
	}
	return &session{
		proc:          proc,
		sessionKey:    opts.SessionKey,
		agentDebugLog: logs.NewAgentLogger(opts.RootPath, opts.SessionKey, opts.AgentName),
	}, nil
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

func mapModelState(state *acpsdk.SessionModelState) types.ModelList {
	if state == nil {
		return types.ModelList{}
	}
	models := make([]types.ModelInfo, 0, len(state.AvailableModels))
	for _, model := range state.AvailableModels {
		models = append(models, types.ModelInfo{
			ID:          strings.TrimSpace(string(model.ModelId)),
			Name:        firstNonEmpty(strings.TrimSpace(model.Name), strings.TrimSpace(string(model.ModelId))),
			Description: stringPtrValue(model.Description),
		})
	}
	return types.ModelList{
		CurrentModelID: strings.TrimSpace(string(state.CurrentModelId)),
		Models:         models,
	}
}

func mapModeState(state *acpsdk.SessionModeState) types.ModeList {
	if state == nil {
		return types.ModeList{}
	}
	modes := make([]types.ModeInfo, 0, len(state.AvailableModes))
	for _, mode := range state.AvailableModes {
		description := ""
		if mode.Description != nil {
			description = *mode.Description
		}
		modes = append(modes, types.ModeInfo{
			ID:          string(mode.Id),
			Name:        mode.Name,
			Description: description,
		})
	}
	return types.ModeList{
		CurrentModeID: string(state.CurrentModeId),
		Modes:         modes,
	}
}

func (r *Runtime) CloseSession(sessionKey string) {
	for _, proc := range r.listProcesses() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = proc.CloseSession(ctx, sessionKey)
		cancel()
	}
}

func (r *Runtime) Close(agentName string) error {
	if strings.TrimSpace(agentName) == "" {
		return nil
	}
	r.mu.Lock()
	proc := r.processes[agentName]
	delete(r.processes, agentName)
	delete(r.closeHints, agentName)
	r.mu.Unlock()
	if proc != nil {
		closeErr := proc.Close()
		if hint, ok := waitForRecentStderrHint(proc, 750*time.Millisecond); ok {
			r.mu.Lock()
			r.closeHints[agentName] = hint
			r.mu.Unlock()
		}
		return closeErr
	}
	return nil
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
	closeProcessesConcurrently(r.listProcessesAndReset(), (*Process).Close)
}

func closeProcessesConcurrently(procs []*Process, closeProcess func(*Process) error) {
	var closeWG sync.WaitGroup
	for _, proc := range procs {
		if proc == nil {
			continue
		}
		closeWG.Add(1)
		go func(proc *Process) {
			defer closeWG.Done()
			if err := closeProcess(proc); err != nil {
				log.Printf("[agent/acp] process.close_all.error agent=%s err=%v", proc.agentLabel(), err)
			}
		}(proc)
	}
	closeWG.Wait()
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

// ProcessIDs returns the live shared process PID keyed by configured agent.
func (r *Runtime) ProcessIDs() map[string]int {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]int, len(r.processes))
	for agentName, proc := range r.processes {
		if pid := proc.ProcessID(); pid > 0 {
			out[agentName] = pid
		}
	}
	return out
}

func (r *Runtime) listProcessesAndReset() []*Process {
	r.mu.Lock()
	defer r.mu.Unlock()
	procs := make([]*Process, 0, len(r.processes))
	for _, proc := range r.processes {
		procs = append(procs, proc)
	}
	r.closed = true
	r.processes = make(map[string]*Process)
	return procs
}

func (r *Runtime) getOrCreateProcess(opts OpenOptions) (*Process, error) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, errors.New("agent runtime closed")
	}
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
	if r.closed {
		r.mu.Unlock()
		proc.Close()
		return nil, errors.New("agent runtime closed")
	}
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
	proc          *Process
	sessionKey    string
	agentDebugLog *logs.AgentLogger
}

func (s *session) SendMessage(ctx context.Context, content string) error {
	return s.proc.SendMessage(ctx, s.sessionKey, content)
}

func (s *session) AnswerQuestion(context.Context, types.AskUserAnswer) error {
	return errors.New("ask user question is not supported by acp sessions")
}

func (s *session) CurrentModel() string {
	if s == nil || s.proc == nil {
		return ""
	}
	if current := strings.TrimSpace(mapModelConfigOptions(s.proc.SessionConfigOptions(s.sessionKey)).CurrentModelID); current != "" {
		return current
	}
	return strings.TrimSpace(mapModelState(s.proc.SessionModelState(s.sessionKey)).CurrentModelID)
}

func (s *session) SetModel(ctx context.Context, model string) error {
	if s == nil || s.proc == nil {
		return errors.New("acp session not initialized")
	}
	return s.proc.SetModel(ctx, s.sessionKey, model)
}

func (s *session) ListModels(_ context.Context) (types.ModelList, error) {
	if s == nil || s.proc == nil {
		return types.ModelList{}, errors.New("acp session not initialized")
	}
	if models := mapModelConfigOptions(s.proc.SessionConfigOptions(s.sessionKey)); len(models.Models) > 0 || models.CurrentModelID != "" {
		return models, nil
	}
	return mapModelState(s.proc.SessionModelState(s.sessionKey)), nil
}

func (s *session) SetMode(ctx context.Context, mode string) error {
	if s == nil || s.proc == nil {
		return errors.New("acp session not initialized")
	}
	return s.proc.SetMode(ctx, s.sessionKey, mode)
}

func (s *session) SetPlanMode(_ context.Context, _ bool) error {
	return nil
}

func (s *session) ListModes(_ context.Context) (types.ModeList, error) {
	if s == nil || s.proc == nil {
		return types.ModeList{}, errors.New("acp session not initialized")
	}
	if modes := mapModeConfigOptions(s.proc.SessionConfigOptions(s.sessionKey)); len(modes.Modes) > 0 || modes.CurrentModeID != "" {
		return modes, nil
	}
	return mapModeState(s.proc.SessionModeState(s.sessionKey)), nil
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
		s.logRawToolUpdate(update)
		if update.Type == UpdateTypeUserMessage {
			return
		}
		if onUpdate != nil {
			if update.Type == UpdateTypeMessageDone {
				contextWindow, _ := s.ContextWindow(context.Background())
				onUpdate(types.Event{
					Type:      types.EventTypeMessageDone,
					SessionID: update.SessionID,
					Data:      types.MessageDone{ContextWindow: contextWindow, TokenUsage: update.TokenUsage},
				})
				return
			}
			ev := convertEvent(update)
			if ev.Type == "" {
				return
			}
			onUpdate(ev)
		}
	})
}

func (s *session) SessionID() string {
	return s.proc.SessionID(s.sessionKey)
}

func (s *session) ContextWindow(_ context.Context) (types.ContextWindow, error) {
	if s == nil || s.proc == nil {
		return types.ContextWindow{}, errors.New("acp session not initialized")
	}
	return s.proc.SessionContextWindow(s.sessionKey), nil
}

func (s *session) RuntimeDefaults(context.Context) (types.RuntimeDefaults, error) {
	if s == nil || s.proc == nil {
		return types.RuntimeDefaults{}, errors.New("acp session not initialized")
	}
	options := s.proc.SessionConfigOptions(s.sessionKey)
	model := configOptionCurrentValue(options, acpsdk.SessionConfigOptionCategoryModel)
	if model == "" {
		model = mapModelState(s.proc.SessionModelState(s.sessionKey)).CurrentModelID
	}
	return types.RuntimeDefaults{
		Model:  model,
		Effort: configOptionCurrentValue(options, acpsdk.SessionConfigOptionCategoryThoughtLevel),
	}, nil
}

func (s *session) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.proc.CloseSession(ctx, s.sessionKey)
}

func (s *session) logRawToolUpdate(update SessionUpdate) {
	if s == nil || s.agentDebugLog == nil {
		return
	}
	if update.Type != UpdateTypeToolCall && update.Type != UpdateTypeToolUpdate {
		return
	}
	raw, err := json.Marshal(update.Raw)
	if err != nil {
		return
	}
	s.agentDebugLog.AppendRaw(raw)
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
		} else {
			logUnhandledConvertEvent(update, "agent_message_chunk")
		}
	case UpdateTypeThoughtChunk:
		if raw.AgentThoughtChunk != nil && raw.AgentThoughtChunk.Content.Text != nil {
			ev.Data = types.ThoughtChunk{Content: raw.AgentThoughtChunk.Content.Text.Text}
		} else {
			logUnhandledConvertEvent(update, "agent_thought_chunk")
		}
	case UpdateTypeToolCall:
		if raw.ToolCall != nil {
			if isACPTodoTool(raw.ToolCall.Title, string(raw.ToolCall.Kind), raw.ToolCall.RawInput, raw.ToolCall.RawOutput) {
				return types.Event{}
			}
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
		} else {
			logUnhandledConvertEvent(update, "tool_call")
		}
	case UpdateTypeToolUpdate:
		if raw.ToolCallUpdate != nil {
			name := ""
			if raw.ToolCallUpdate.Title != nil {
				name = *raw.ToolCallUpdate.Title
			}
			rawKind := ""
			if raw.ToolCallUpdate.Kind != nil {
				rawKind = string(*raw.ToolCallUpdate.Kind)
			}
			if isACPTodoTool(name, rawKind, raw.ToolCallUpdate.RawInput, raw.ToolCallUpdate.RawOutput) {
				return types.Event{}
			}
			status := "complete"
			if raw.ToolCallUpdate.Status != nil && *raw.ToolCallUpdate.Status == acpsdk.ToolCallStatusFailed {
				status = "failed"
			}
			kind := types.ToolKind("")
			if raw.ToolCallUpdate.Kind != nil {
				kind = types.ToolKind(*raw.ToolCallUpdate.Kind)
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
		} else {
			logUnhandledConvertEvent(update, "tool_call_update")
		}
	case UpdateTypePlan:
		if raw.Plan != nil {
			ev.Type = types.EventTypeTodoUpdate
			ev.Data = types.TodoUpdate{Items: convertACPPlanEntriesToTodos(raw.Plan.Entries)}
		} else if raw.PlanUpdate != nil {
			ev.Type, ev.Data = convertACPPlanUpdate(*raw.PlanUpdate)
		} else {
			logUnhandledConvertEvent(update, "plan")
		}
	default:
		logUnhandledConvertEvent(update, "update_type")
	}
	return ev
}

func isACPTodoTool(title, kind string, rawInput, rawOutput any) bool {
	normalizedKind := strings.ToLower(strings.TrimSpace(kind))
	if normalizedKind != "" && normalizedKind != "other" && normalizedKind != "todo" {
		return false
	}
	normalizedTitle := strings.ToLower(strings.TrimSpace(title))
	if normalizedTitle == "todowrite" {
		return true
	}
	return strings.HasSuffix(normalizedTitle, " todos") && (hasACPTodosPayload(rawInput) || hasACPTodosPayload(rawOutput))
}

func hasACPTodosPayload(value any) bool {
	normalized := normalizeACPValue(value)
	data, ok := normalized.(map[string]any)
	if !ok {
		return false
	}
	if _, ok := data["todos"]; ok {
		return true
	}
	metadata, ok := data["metadata"].(map[string]any)
	if !ok {
		return false
	}
	_, ok = metadata["todos"]
	return ok
}

func normalizeACPValue(value any) any {
	switch v := value.(type) {
	case []byte:
		var decoded any
		if err := json.Unmarshal(v, &decoded); err == nil {
			return decoded
		}
	case json.RawMessage:
		var decoded any
		if err := json.Unmarshal(v, &decoded); err == nil {
			return decoded
		}
	case string:
		var decoded any
		if err := json.Unmarshal([]byte(v), &decoded); err == nil {
			return decoded
		}
	}
	return value
}

func convertACPPlanUpdate(update acpsdk.SessionPlanUpdate) (types.EventType, any) {
	content := update.Plan
	switch {
	case content.Markdown != nil:
		return types.EventTypePlanUpdate, types.PlanUpdate{
			ID:      string(content.Markdown.Id),
			Content: strings.TrimSpace(content.Markdown.Content),
		}
	case content.Items != nil:
		return types.EventTypeTodoUpdate, types.TodoUpdate{Items: convertACPPlanEntriesToTodos(content.Items.Entries)}
	case content.File != nil:
		return types.EventTypePlanUpdate, types.PlanUpdate{
			ID:      string(content.File.Id),
			Content: strings.TrimSpace("Plan file: " + content.File.Uri),
		}
	default:
		return types.EventTypePlanUpdate, types.PlanUpdate{}
	}
}

func acpPlanUpdateID(update acpsdk.SessionPlanUpdate) string {
	content := update.Plan
	switch {
	case content.Markdown != nil:
		return string(content.Markdown.Id)
	case content.Items != nil:
		return string(content.Items.Id)
	case content.File != nil:
		return string(content.File.Id)
	default:
		return ""
	}
}

func convertACPPlanEntriesToTodos(entries []acpsdk.PlanEntry) []types.TodoItem {
	if len(entries) == 0 {
		return nil
	}
	items := make([]types.TodoItem, 0, len(entries))
	for _, entry := range entries {
		content := strings.TrimSpace(entry.Content)
		if content == "" {
			continue
		}
		items = append(items, types.TodoItem{
			Content: content,
			Status:  normalizeACPPlanStatus(entry.Status),
		})
	}
	return items
}

func normalizeACPPlanStatus(status acpsdk.PlanEntryStatus) string {
	switch status {
	case acpsdk.PlanEntryStatusCompleted:
		return "completed"
	case acpsdk.PlanEntryStatusInProgress:
		return "in_progress"
	default:
		return "pending"
	}
}

func logUnhandledConvertEvent(update SessionUpdate, scope string) {
	log.Printf(
		"[agent/acp] unhandled.%s raw=%s",
		scope,
		truncateRawJSON(update.Raw),
	)
}

func truncateRawJSON(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return `{"marshal_error":true}`
	}
	const maxRawLogBytes = 1024
	if len(raw) > maxRawLogBytes {
		raw = append(raw[:maxRawLogBytes], []byte("...(truncated)")...)
	}
	return string(raw)
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
