package codex

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strconv"
	"strings"
	"sync"

	"mindfs/server/internal/agent/logs"
	types "mindfs/server/internal/agent/types"

	codexsdk "github.com/fanwenlin/codex-go-sdk/codex"
	codextypes "github.com/fanwenlin/codex-go-sdk/types"
)

type OpenOptions struct {
	AgentName        string
	SessionKey       string
	Model            string
	Effort           string
	FastService      string
	PlanMode         bool
	Probe            bool
	RootPath         string
	Command          string
	Args             []string
	Env              map[string]string
	ResumeSessionID  string
	ForkSessionID    string
	CodexUserOrdinal *int
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
	var sess *session
	threadOptions := codexsdk.ThreadOptions{
		Model:                strings.TrimSpace(opts.Model),
		ModelReasoningEffort: codexsdk.ModelReasoningEffort(strings.TrimSpace(opts.Effort)),
		FastService:          strings.TrimSpace(opts.FastService),
		SandboxMode:          codexsdk.SandboxModeFullAccess,
		WorkingDirectory:     opts.RootPath,
		ApprovalPolicy:       codexsdk.ApprovalModeNever,
		ApprovalHandler: func(_ codexsdk.ApprovalRequest) (codexsdk.ApprovalDecision, error) {
			return codexsdk.ApprovalDecisionApproved, nil
		},
		AskUserHandler: func(req codexsdk.AskUserRequest) (codexsdk.AskUserResponse, error) {
			if sess == nil {
				return codexsdk.AskUserResponse{}, errors.New("codex session not initialized")
			}
			return sess.handleAskUserRequest(req)
		},
	}
	if opts.PlanMode {
		threadOptions.CollaborationMode = codexCollaborationMode(true)
	}

	var thread *codexsdk.Thread
	if strings.TrimSpace(opts.ForkSessionID) != "" {
		threadID, err := forkCodexThread(context.Background(), client, threadOptions, strings.TrimSpace(opts.ForkSessionID), opts.CodexUserOrdinal)
		if err != nil {
			return nil, err
		}
		opts.ResumeSessionID = threadID
		thread = client.ResumeThread(threadID, threadOptions)
	} else if strings.TrimSpace(opts.ResumeSessionID) != "" {
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
	sess = &session{
		client:        client,
		thread:        thread,
		threadOpts:    threadOptions,
		threadID:      threadID,
		sessionKey:    opts.SessionKey,
		planMode:      opts.PlanMode,
		questionWaits: make(map[string]chan codexAskUserAnswerResult),
		agentDebugLog: logs.NewAgentLogger(opts.RootPath, opts.SessionKey, opts.AgentName),
	}
	return sess, nil
}

func forkCodexThread(ctx context.Context, client *codexsdk.Codex, opts codexsdk.ThreadOptions, sourceThreadID string, userOrdinal *int) (string, error) {
	sourceThreadID = strings.TrimSpace(sourceThreadID)
	if sourceThreadID == "" {
		return "", errors.New("codex source thread id required")
	}

	thread, err := client.ForkThread(ctx, sourceThreadID, codexsdk.ThreadForkOptions{
		ThreadOptions:                opts,
		TruncateBeforeNthUserMessage: userOrdinal,
	})
	if err != nil {
		return "", err
	}
	var threadID string
	if thread != nil && thread.ID() != nil {
		threadID = strings.TrimSpace(*thread.ID())
	}
	if threadID == "" {
		return "", errors.New("codex thread/fork did not return thread id")
	}
	return threadID, nil
}

func codexCollaborationMode(enabled bool) *codexsdk.CollaborationMode {
	if enabled {
		return codexsdk.NewCollaborationMode(codexsdk.CollaborationModePlan)
	}
	return codexsdk.NewCollaborationMode(codexsdk.CollaborationModeDefault)
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
	planMode   bool

	mu            sync.RWMutex
	onUpdate      func(types.Event)
	turn          types.TurnCanceler
	contextWindow types.ContextWindow
	planTextByID  map[string]string

	agentDebugLog *logs.AgentLogger

	questionMu    sync.Mutex
	questionWaits map[string]chan codexAskUserAnswerResult
}

type codexAskUserAnswerResult struct {
	answers map[string]string
	err     error
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

	if err := s.handleStreamedEvents(streamed.Events); err != nil {
		return err
	}
	s.updateThreadIDFromThread()
	return nil
}

func (s *session) SubscribeThreadEvents(ctx context.Context) error {
	if s == nil || s.client == nil {
		return errors.New("codex session not initialized")
	}
	turnCtx, turnID := s.turn.Begin(ctx)
	defer s.turn.End(turnID)
	threadID := strings.TrimSpace(s.SessionID())
	if threadID == "" {
		s.updateThreadIDFromThread()
		threadID = strings.TrimSpace(s.SessionID())
	}
	if threadID == "" {
		return errors.New("codex thread id required")
	}
	streamed, err := s.client.SubscribeThreadEvents(turnCtx, threadID, s.threadOpts)
	if err != nil {
		return err
	}
	return s.handleStreamedEvents(streamed.Events)
}

func (s *session) handleStreamedEvents(events <-chan codexsdk.ThreadEvent) error {
	textByID := map[string]string{}
	for event := range events {
		raw, _ := json.Marshal(event)
		switch e := event.(type) {
		case *codexsdk.ThreadStartedEvent:
			s.setThreadID(e.ThreadId)
		case *codexsdk.ItemStartedEvent:
			s.logRawToolItem(e.Item)
			if s.handleNonToolItem(e.Item, true) {
				continue
			}
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
			if s.handleNonToolItem(e.Item, false) {
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
			if s.handleNonToolItem(e.Item, false) {
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
			contextWindow, _ := s.ContextWindow(context.Background())
			s.emit(types.Event{
				Type:      types.EventTypeMessageDone,
				SessionID: s.SessionID(),
				Data:      types.MessageDone{ContextWindow: contextWindow},
			})
		case *codexsdk.TurnFailedEvent:
			log.Printf("[agent/codex] send.error session=%s err=%s", s.sessionKey, e.Error.Message)
			return errors.New("codex turn failed: " + e.Error.Message)
		case *codexsdk.ThreadErrorEvent:
			log.Printf("[agent/codex] send.error session=%s err=%s", s.sessionKey, e.Message)
			return errors.New("codex thread error: " + e.Message)
		case *codexsdk.RawEvent:
			if s.handleRawEvent(e) {
				continue
			}
			logUnhandledEvent(s.sessionKey, "raw_event", raw)
		default:
			logUnhandledEvent(s.sessionKey, "event", raw)
		}
	}
	return nil
}

func (s *session) handleNonToolItem(item codexsdk.ThreadItem, started bool) bool {
	switch v := item.(type) {
	case *codexsdk.ReasoningItem:
		if started {
			return true
		}
		summary := strings.TrimSpace(strings.Join(v.Summary, "\n"))
		if summary != "" {
			s.emit(types.Event{Type: types.EventTypeThoughtChunk, SessionID: s.SessionID(), Data: types.ThoughtChunk{ID: v.ID, Content: summary}})
		}
		return true
	case *codexsdk.TodoListItem:
		items := make([]types.TodoItem, 0, len(v.Items))
		for _, item := range v.Items {
			content := strings.TrimSpace(item.Text)
			if content == "" {
				continue
			}
			status := "pending"
			if item.Completed {
				status = "completed"
			}
			items = append(items, types.TodoItem{Content: content, Status: status})
		}
		s.emit(types.Event{Type: types.EventTypeTodoUpdate, SessionID: s.SessionID(), Data: types.TodoUpdate{Items: items}})
		return true
	case *codexsdk.CompactedItem:
		status := "complete"
		if started {
			status = "running"
		}
		s.emit(types.Event{Type: types.EventTypeCompact, SessionID: s.SessionID(), Data: types.CompactNotice{ID: v.ID, Status: status, Summary: v.Summary}})
		return true
	case *codextypes.UnknownItem:
		switch v.GetType() {
		case "plan":
			plan, ok := parseUnknownPlan(v.Raw)
			if ok {
				s.emit(types.Event{Type: types.EventTypePlanUpdate, SessionID: s.SessionID(), Data: plan})
			}
			return true
		case "contextCompaction":
			compact := parseUnknownContextCompaction(v.Raw)
			s.emit(types.Event{Type: types.EventTypeCompact, SessionID: s.SessionID(), Data: compact})
			return true
		}
		return false
	default:
		switch item.GetType() {
		case "plan":
			return true
		case "contextCompaction":
			s.emit(types.Event{Type: types.EventTypeCompact, SessionID: s.SessionID(), Data: types.CompactNotice{Status: "complete"}})
			return true
		}
		return false
	}
}

func parseUnknownPlan(raw json.RawMessage) (types.PlanUpdate, bool) {
	var payload struct {
		ID   string `json:"id"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return types.PlanUpdate{}, false
	}
	content := strings.TrimSpace(payload.Text)
	if content == "" {
		return types.PlanUpdate{}, false
	}
	return types.PlanUpdate{ID: payload.ID, Content: content}, true
}

func parseUnknownContextCompaction(raw json.RawMessage) types.CompactNotice {
	var payload struct {
		ID      string `json:"id"`
		Summary string `json:"summary"`
	}
	_ = json.Unmarshal(raw, &payload)
	return types.CompactNotice{ID: payload.ID, Status: "complete", Summary: payload.Summary}
}

func (s *session) AnswerQuestion(ctx context.Context, answer types.AskUserAnswer) error {
	callID := strings.TrimSpace(answer.ToolUseID)
	if callID == "" {
		return errors.New("toolUseId required")
	}
	if len(answer.Answers) == 0 {
		return errors.New("answers required")
	}

	s.questionMu.Lock()
	waiter, ok := s.questionWaits[callID]
	s.questionMu.Unlock()
	if !ok {
		return errors.New("question is not pending: " + callID)
	}

	answers := make(map[string]string, len(answer.Answers))
	for key, value := range answer.Answers {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key != "" && value != "" {
			answers[key] = value
		}
	}
	if len(answers) == 0 {
		return errors.New("answers required")
	}

	select {
	case waiter <- codexAskUserAnswerResult{answers: answers}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *session) handleAskUserRequest(req codexsdk.AskUserRequest) (codexsdk.AskUserResponse, error) {
	callID := strings.TrimSpace(req.ItemID)
	if callID == "" {
		return codexsdk.AskUserResponse{}, errors.New("ask user question missing item id")
	}
	if len(req.Questions) == 0 {
		return codexsdk.AskUserResponse{}, errors.New("ask user question missing questions")
	}

	waiter := make(chan codexAskUserAnswerResult, 1)
	s.questionMu.Lock()
	if s.questionWaits == nil {
		s.questionWaits = make(map[string]chan codexAskUserAnswerResult)
	}
	if _, exists := s.questionWaits[callID]; exists {
		s.questionMu.Unlock()
		return codexsdk.AskUserResponse{}, errors.New("ask user question already pending: " + callID)
	}
	s.questionWaits[callID] = waiter
	s.questionMu.Unlock()
	defer func() {
		s.questionMu.Lock()
		delete(s.questionWaits, callID)
		s.questionMu.Unlock()
	}()

	toolCall := codexAskUserToolCall(callID, req)
	s.emit(types.Event{
		Type:      types.EventTypeToolCall,
		SessionID: s.SessionID(),
		Data:      toolCall,
	})

	result := <-waiter
	if result.err != nil {
		return codexsdk.AskUserResponse{}, result.err
	}
	response := codexAskUserResponse(req.Questions, result.answers)
	if len(response.Answers) == 0 {
		return codexsdk.AskUserResponse{}, errors.New("empty ask user answers")
	}
	return response, nil
}

func (s *session) cancelPendingQuestions(err error) {
	if err == nil {
		err = errors.New("turn canceled")
	}
	s.questionMu.Lock()
	waiters := make([]chan codexAskUserAnswerResult, 0, len(s.questionWaits))
	for callID, waiter := range s.questionWaits {
		waiters = append(waiters, waiter)
		delete(s.questionWaits, callID)
	}
	s.questionMu.Unlock()

	for _, waiter := range waiters {
		select {
		case waiter <- codexAskUserAnswerResult{err: err}:
		default:
		}
	}
}

func codexAskUserToolCall(callID string, req codexsdk.AskUserRequest) types.ToolCall {
	questions := make([]types.AskUserQuestionItem, 0, len(req.Questions))
	for _, question := range req.Questions {
		options := make([]types.AskUserQuestionOption, 0, len(question.Options))
		for _, option := range question.Options {
			options = append(options, types.AskUserQuestionOption{
				Label:       option.Label,
				Description: option.Description,
			})
		}
		questions = append(questions, types.AskUserQuestionItem{
			Question: question.Question,
			Header:   question.Header,
			Options:  options,
		})
	}

	raw, _ := json.Marshal(map[string]any{"questions": questions})
	meta := map[string]any{
		"toolUseId": callID,
		"questions": questions,
		"rawType":   "request_user_input",
		"input":     strings.TrimSpace(string(raw)),
	}
	if strings.TrimSpace(req.ThreadID) != "" {
		meta["threadId"] = strings.TrimSpace(req.ThreadID)
	}
	if strings.TrimSpace(req.TurnID) != "" {
		meta["turnId"] = strings.TrimSpace(req.TurnID)
	}
	return types.ToolCall{
		CallID:  callID,
		Title:   "ask user",
		Status:  "running",
		Kind:    types.ToolKindAskUser,
		RawType: "request_user_input",
		Meta:    meta,
	}
}

func codexAskUserResponse(questions []codexsdk.AskUserQuestion, answers map[string]string) codexsdk.AskUserResponse {
	response := codexsdk.AskUserResponse{Answers: make(map[string]codexsdk.AskUserAnswer)}
	for key, value := range answers {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" || value == "" {
			continue
		}
		questionID := codexQuestionIDForAnswerKey(key, questions)
		if questionID == "" {
			continue
		}
		response.Answers[questionID] = codexsdk.AskUserAnswer{
			Answers: []string{value},
		}
	}
	return response
}

func codexQuestionIDForAnswerKey(key string, questions []codexsdk.AskUserQuestion) string {
	if strings.HasPrefix(key, "q_") {
		indexText := strings.TrimPrefix(key, "q_")
		for index, question := range questions {
			if indexText == strconv.Itoa(index) {
				return strings.TrimSpace(question.ID)
			}
		}
	}
	for _, question := range questions {
		if key == strings.TrimSpace(question.ID) {
			return key
		}
	}
	return ""
}

func (s *session) CurrentModel() string {
	if s == nil {
		return ""
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return strings.TrimSpace(s.threadOpts.Model)
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
	opts.CollaborationMode = codexCollaborationMode(s.planMode)
	thread := s.client.ResumeThread(threadID, opts)
	s.mu.Lock()
	s.thread = thread
	s.threadOpts = opts
	s.threadID = threadID
	s.mu.Unlock()
	return nil
}

func (s *session) SetPlanMode(_ context.Context, enabled bool) error {
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
	opts.CollaborationMode = codexCollaborationMode(enabled)
	thread := s.client.ResumeThread(threadID, opts)
	s.mu.Lock()
	s.thread = thread
	s.threadOpts = opts
	s.threadID = threadID
	s.planMode = enabled
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
	defaults, _ := s.RuntimeDefaults(ctx)
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
	if strings.TrimSpace(defaults.Model) != "" {
		currentModelID = strings.TrimSpace(defaults.Model)
	}
	return types.ModelList{
		CurrentModelID: currentModelID,
		Models:         models,
	}, nil
}

func (s *session) RuntimeDefaults(ctx context.Context) (types.RuntimeDefaults, error) {
	if s == nil || s.client == nil {
		return types.RuntimeDefaults{}, errors.New("codex session not initialized")
	}
	params := codexsdk.ConfigReadParams{
		IncludeLayers: false,
		Cwd:           strings.TrimSpace(s.threadOpts.WorkingDirectory),
	}
	resp, err := s.client.ReadConfig(ctx, params)
	if err != nil {
		log.Printf("[codex/runtime_defaults] config.read.error cwd=%q err=%v", params.Cwd, err)
		return types.RuntimeDefaults{}, err
	}
	defaults := types.RuntimeDefaults{}
	if resp == nil {
		log.Printf("[codex/runtime_defaults] config.read.empty cwd=%q", params.Cwd)
		return defaults, nil
	}
	if resp.Config.Model != nil {
		defaults.Model = strings.TrimSpace(*resp.Config.Model)
	}
	if resp.Config.ModelReasoningEffort != nil {
		defaults.Effort = strings.TrimSpace(string(*resp.Config.ModelReasoningEffort))
	}
	if resp.Config.ServiceTier != nil {
		if strings.TrimSpace(*resp.Config.ServiceTier) == "fast" {
			defaults.FastService = "on"
		} else {
			defaults.FastService = "off"
		}
	}
	return defaults, nil
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
	s.cancelPendingQuestions(errors.New("turn canceled"))
	s.turn.Cancel()
	return nil
}

func (s *session) SessionID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.threadID
}

func (s *session) ContextWindow(_ context.Context) (types.ContextWindow, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.contextWindow, nil
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

func (s *session) handleRawEvent(event *codexsdk.RawEvent) bool {
	if event == nil {
		return false
	}
	switch normalizeEventType(event.Type) {
	case "thread.tokenUsage.updated":
		usage, ok := parseContextWindow(event.Raw)
		if !ok {
			return false
		}
		s.mu.Lock()
		s.contextWindow = usage
		s.mu.Unlock()
		return true
	case "item.plan.delta":
		plan, ok := parsePlanDelta(event.Raw)
		if !ok {
			return false
		}
		plan = s.accumulatePlanUpdate(plan)
		s.emit(types.Event{Type: types.EventTypePlanUpdate, SessionID: s.SessionID(), Data: plan})
		return true
	case "turn.plan.updated":
		todo, ok := parseTurnPlanUpdate(event.Raw)
		if !ok {
			return false
		}
		s.emit(types.Event{Type: types.EventTypeTodoUpdate, SessionID: s.SessionID(), Data: todo})
		return true
	}
	return false
}

func (s *session) accumulatePlanUpdate(plan types.PlanUpdate) types.PlanUpdate {
	if !plan.Delta {
		return plan
	}
	id := strings.TrimSpace(plan.ID)
	if id == "" {
		return plan
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.planTextByID == nil {
		s.planTextByID = make(map[string]string)
	}
	next := s.planTextByID[id] + plan.Content
	s.planTextByID[id] = next
	plan.Content = next
	plan.Delta = false
	return plan
}

func normalizeEventType(value string) string {
	return strings.ReplaceAll(strings.TrimSpace(value), "/", ".")
}

func parsePlanDelta(raw json.RawMessage) (types.PlanUpdate, bool) {
	var payload struct {
		ItemID string `json:"itemId"`
		Delta  string `json:"delta"`
		Raw    struct {
			ItemID string `json:"itemId"`
			Delta  string `json:"delta"`
		} `json:"raw"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return types.PlanUpdate{}, false
	}
	itemID := firstNonEmpty(payload.ItemID, payload.Raw.ItemID)
	delta := firstNonEmpty(payload.Delta, payload.Raw.Delta)
	if strings.TrimSpace(itemID) == "" && strings.TrimSpace(delta) == "" {
		return types.PlanUpdate{}, false
	}
	return types.PlanUpdate{ID: itemID, Content: delta, Delta: true}, true
}

func parseTurnPlanUpdate(raw json.RawMessage) (types.TodoUpdate, bool) {
	var payload struct {
		Plan []struct {
			Step   string `json:"step"`
			Status string `json:"status"`
		} `json:"plan"`
		Raw struct {
			Plan []struct {
				Step   string `json:"step"`
				Status string `json:"status"`
			} `json:"plan"`
		} `json:"raw"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return types.TodoUpdate{}, false
	}
	steps := payload.Plan
	if len(steps) == 0 {
		steps = payload.Raw.Plan
	}
	if len(steps) == 0 {
		return types.TodoUpdate{}, false
	}
	items := make([]types.TodoItem, 0, len(steps))
	for _, step := range steps {
		content := strings.TrimSpace(step.Step)
		if content == "" {
			continue
		}
		items = append(items, types.TodoItem{Content: content, Status: normalizeTodoStatus(step.Status)})
	}
	return types.TodoUpdate{Items: items}, len(items) > 0
}

func normalizeTodoStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "complete", "done":
		return "completed"
	case "inprogress", "in_progress", "running":
		return "in_progress"
	default:
		return "pending"
	}
}

func parseContextWindow(raw json.RawMessage) (types.ContextWindow, bool) {
	var payload struct {
		TokenUsage struct {
			Last struct {
				TotalTokens int `json:"totalTokens"`
			} `json:"last"`
			Total struct {
				TotalTokens int `json:"totalTokens"`
			} `json:"total"`
			ModelContextWindow int `json:"modelContextWindow"`
		} `json:"tokenUsage"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return types.ContextWindow{}, false
	}
	totalTokens := payload.TokenUsage.Last.TotalTokens
	if totalTokens == 0 {
		totalTokens = payload.TokenUsage.Total.TotalTokens
	}
	if totalTokens == 0 && payload.TokenUsage.ModelContextWindow == 0 {
		return types.ContextWindow{}, false
	}
	return types.ContextWindow{
		TotalTokens:        totalTokens,
		ModelContextWindow: payload.TokenUsage.ModelContextWindow,
	}, true
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
		if strings.TrimSpace(v.Source) != "" {
			meta["source"] = v.Source
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
	case *codexsdk.WebSearchItem:
		query := strings.TrimSpace(v.Query)
		content := []types.ToolCallContentItem{}
		if query != "" {
			content = append(content, types.ToolCallContentItem{Type: "text", Text: "**Query:** " + query})
		}
		return types.ToolCall{
			CallID:  v.ID,
			Title:   firstNonEmpty(query, "web search"),
			Status:  normalizeStatus("", started),
			Kind:    types.ToolKindWebSearch,
			Content: content,
			RawType: "webSearch",
			Meta: map[string]any{
				"rawType": "webSearch",
				"query":   query,
			},
		}, true
	case *codexsdk.ErrorItem:
		message := strings.TrimSpace(v.Message)
		if message == "" {
			message = "codex item error"
		}
		return types.ToolCall{
			CallID:  v.ID,
			Title:   "error",
			Status:  "failed",
			Kind:    types.ToolKindOther,
			Content: []types.ToolCallContentItem{{Type: "text", Text: message}},
			RawType: "error",
			Meta: map[string]any{
				"rawType": "error",
			},
		}, true
	case *codexsdk.CollabToolCallItem:
		status := normalizeStatus(v.Status, started)
		meta := map[string]any{
			"rawType":           "collabToolCall",
			"type":              v.Type,
			"tool":              v.Tool,
			"status":            status,
			"senderThreadId":    v.SenderThreadID,
			"receiverThreadIds": append([]string(nil), v.ReceiverThreadIDs...),
			"agentsStates":      v.AgentsStates,
		}
		if prompt := stringPtrValue(v.Prompt); prompt != "" {
			meta["prompt"] = prompt
		}
		if model := stringPtrValue(v.Model); model != "" {
			meta["model"] = model
		}
		if effort := stringPtrValue(v.ReasoningEffort); effort != "" {
			meta["reasoningEffort"] = effort
		}
		if v.Arguments != nil {
			meta["arguments"] = v.Arguments
		}
		if v.Result != nil {
			meta["result"] = v.Result
		}
		content := collabToolContent(v)
		content = append(content, errorContent(v.Error)...)
		return types.ToolCall{
			CallID:  v.ID,
			Title:   collabToolTitle(v),
			Status:  status,
			Kind:    types.ToolKindTask,
			Content: content,
			RawType: "collabToolCall",
			Meta:    meta,
		}, true
	case *codextypes.UnknownItem:
		return mapUnknownToolItem(v, started)
	default:
		return types.ToolCall{}, false
	}
}

func mapUnknownToolItem(item *codextypes.UnknownItem, started bool) (types.ToolCall, bool) {
	if item == nil {
		return types.ToolCall{}, false
	}
	switch item.GetType() {
	case "dynamicToolCall":
		return mapDynamicToolCall(item.Raw, started)
	case "hookPrompt":
		return mapHookPrompt(item.Raw, started)
	case "imageGeneration":
		return mapImageGeneration(item.Raw, started)
	default:
		return types.ToolCall{}, false
	}
}

func mapDynamicToolCall(raw json.RawMessage, started bool) (types.ToolCall, bool) {
	var payload struct {
		ID           string          `json:"id"`
		Namespace    *string         `json:"namespace"`
		Tool         string          `json:"tool"`
		Arguments    json.RawMessage `json:"arguments"`
		Status       string          `json:"status"`
		ContentItems []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			ImageURL string `json:"imageUrl"`
		} `json:"contentItems"`
		Success    *bool `json:"success"`
		DurationMs *int  `json:"durationMs"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return types.ToolCall{}, false
	}
	meta := map[string]any{
		"rawType": "dynamicToolCall",
		"tool":    payload.Tool,
	}
	if payload.Namespace != nil && strings.TrimSpace(*payload.Namespace) != "" {
		meta["namespace"] = strings.TrimSpace(*payload.Namespace)
	}
	if len(payload.Arguments) > 0 && string(payload.Arguments) != "null" {
		meta["arguments"] = string(payload.Arguments)
	}
	if payload.Success != nil {
		meta["success"] = *payload.Success
	}
	if payload.DurationMs != nil {
		meta["durationMs"] = *payload.DurationMs
	}
	content := make([]types.ToolCallContentItem, 0, len(payload.ContentItems))
	for _, item := range payload.ContentItems {
		if strings.TrimSpace(item.Text) != "" {
			content = append(content, types.ToolCallContentItem{Type: "text", Text: item.Text})
		} else if strings.TrimSpace(item.ImageURL) != "" {
			content = append(content, types.ToolCallContentItem{Type: "text", Text: item.ImageURL})
		}
	}
	return types.ToolCall{
		CallID:  payload.ID,
		Title:   firstNonEmpty(payload.Tool, "dynamic tool"),
		Status:  normalizeStatus(payload.Status, started),
		Kind:    types.ToolKindOther,
		Content: content,
		RawType: "dynamicToolCall",
		Meta:    meta,
	}, true
}

func mapHookPrompt(raw json.RawMessage, started bool) (types.ToolCall, bool) {
	var payload struct {
		ID        string `json:"id"`
		Fragments []struct {
			Text      string `json:"text"`
			HookRunID string `json:"hookRunId"`
		} `json:"fragments"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return types.ToolCall{}, false
	}
	parts := make([]string, 0, len(payload.Fragments))
	hookRunIDs := make([]string, 0, len(payload.Fragments))
	for _, fragment := range payload.Fragments {
		if text := strings.TrimSpace(fragment.Text); text != "" {
			parts = append(parts, text)
		}
		if id := strings.TrimSpace(fragment.HookRunID); id != "" {
			hookRunIDs = append(hookRunIDs, id)
		}
	}
	meta := map[string]any{"rawType": "hookPrompt"}
	if len(hookRunIDs) > 0 {
		meta["hookRunIds"] = hookRunIDs
	}
	content := []types.ToolCallContentItem{}
	if len(parts) > 0 {
		content = append(content, types.ToolCallContentItem{Type: "text", Text: strings.Join(parts, "\n\n")})
	}
	return types.ToolCall{
		CallID:  payload.ID,
		Title:   "hook prompt",
		Status:  normalizeStatus("", started),
		Kind:    types.ToolKindOther,
		Content: content,
		RawType: "hookPrompt",
		Meta:    meta,
	}, true
}

func mapImageGeneration(raw json.RawMessage, started bool) (types.ToolCall, bool) {
	var payload struct {
		ID            string  `json:"id"`
		Status        string  `json:"status"`
		RevisedPrompt *string `json:"revisedPrompt"`
		Result        string  `json:"result"`
		SavedPath     string  `json:"savedPath"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return types.ToolCall{}, false
	}
	content := []types.ToolCallContentItem{}
	if prompt := stringPtrValue(payload.RevisedPrompt); prompt != "" {
		content = append(content, types.ToolCallContentItem{Type: "text", Text: prompt})
	}
	if strings.TrimSpace(payload.Result) != "" {
		content = append(content, types.ToolCallContentItem{Type: "text", Text: payload.Result})
	}
	if strings.TrimSpace(payload.SavedPath) != "" {
		content = append(content, types.ToolCallContentItem{Type: "text", Text: payload.SavedPath})
	}
	return types.ToolCall{
		CallID:  payload.ID,
		Title:   "image generation",
		Status:  normalizeStatus(payload.Status, started),
		Kind:    types.ToolKindOther,
		Content: content,
		RawType: "imageGeneration",
		Meta: map[string]any{
			"rawType": "imageGeneration",
		},
	}, true
}

func isToolItem(item codexsdk.ThreadItem) bool {
	switch item.(type) {
	case *codexsdk.CommandExecutionItem, *codexsdk.FileChangeItem, *codexsdk.McpToolCallItem, *codexsdk.WebSearchItem, *codexsdk.ErrorItem, *codexsdk.CollabToolCallItem:
		return true
	case *codextypes.UnknownItem:
		switch item.GetType() {
		case "dynamicToolCall", "hookPrompt", "imageGeneration":
			return true
		}
		return false
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

func collabToolContent(item *codexsdk.CollabToolCallItem) []types.ToolCallContentItem {
	if item == nil {
		return nil
	}
	if strings.EqualFold(strings.TrimSpace(item.Tool), "wait") {
		return nil
	}
	if prompt := stringPtrValue(item.Prompt); prompt != "" {
		return []types.ToolCallContentItem{{Type: "text", Text: prompt}}
	}
	return nil
}

func collabToolTitle(item *codexsdk.CollabToolCallItem) string {
	if item == nil {
		return "collab_tool"
	}
	receiver := firstNonEmpty(item.ReceiverThreadIDs...)
	tool := strings.TrimSpace(item.Tool)
	switch tool {
	case "spawnAgent":
		parts := make([]string, 0, 2)
		if model := stringPtrValue(item.Model); model != "" {
			parts = append(parts, model)
		}
		if effort := stringPtrValue(item.ReasoningEffort); effort != "" {
			parts = append(parts, effort)
		}
		settings := ""
		if len(parts) > 0 {
			settings = " (" + strings.Join(parts, " ") + ")"
		}
		prompt := truncateRunes(stringPtrValue(item.Prompt), 80)
		return strings.TrimSpace("Spawn " + receiver + settings + "  " + prompt)
	case "wait":
		return strings.TrimSpace("Waiting for " + receiver)
	default:
		return firstNonEmpty(tool, "collab_tool")
	}
}

func stringPtrValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func truncateRunes(value string, limit int) string {
	runes := []rune(strings.TrimSpace(value))
	if limit <= 0 || len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "..."
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
