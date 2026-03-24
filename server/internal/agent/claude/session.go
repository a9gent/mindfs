package claude

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"

	claudeagent "github.com/roasbeef/claude-agent-sdk-go"
	types "mindfs/server/internal/agent/types"
)

const chunkFlushThreshold = 24

type deltaType string

const (
	deltaTypeText     deltaType = "text"
	deltaTypeThinking deltaType = "thinking"
)

type OpenOptions struct {
	AgentName  string
	SessionKey string
	Model      string
	RootPath   string
	Command    string
	Args       []string
	Env        map[string]string
}

type Runtime struct{}

func NewRuntime() *Runtime {
	return &Runtime{}
}

func (r *Runtime) OpenSession(ctx context.Context, opts OpenOptions) (types.Session, error) {
	if opts.SessionKey == "" {
		return nil, errors.New("session key required")
	}

	optionList := []claudeagent.Option{
		claudeagent.WithCwd(opts.RootPath),
		claudeagent.WithEnv(opts.Env),
		claudeagent.WithVerbose(true),
		claudeagent.WithIncludePartialMessages(true),
		claudeagent.WithCanUseTool(func(context.Context, claudeagent.ToolPermissionRequest) claudeagent.PermissionResult {
			return claudeagent.PermissionAllow{}
		}),
	}
	if strings.TrimSpace(opts.Command) != "" {
		optionList = append(optionList, claudeagent.WithCLIPath(opts.Command))
	}
	if strings.TrimSpace(opts.Model) != "" {
		optionList = append(optionList, claudeagent.WithModel(strings.TrimSpace(opts.Model)))
	}

	client, err := claudeagent.NewClient(optionList...)
	if err != nil {
		return nil, err
	}
	stream, err := client.Stream(ctx)
	if err != nil {
		client.Close()
		return nil, err
	}

	s := &session{
		client:     client,
		stream:     stream,
		sessionID:  stream.SessionID(),
		sessionKey: opts.SessionKey,
	}
	go s.consumeMessages()
	return s, nil
}

func (r *Runtime) CloseAll() {}

type session struct {
	client *claudeagent.Client
	stream *claudeagent.Stream

	mu         sync.RWMutex
	onUpdate   func(types.Event)
	sessionID  string
	sessionKey string

	sendMu sync.Mutex
	turnMu sync.Mutex
	turns  []chan error

	closeOnce sync.Once
	turn      types.TurnCanceler

	sawDelta        bool
	pendingText     strings.Builder
	pendingThinking strings.Builder
}

func (s *session) SendMessage(ctx context.Context, content string) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()

	if s.stream == nil {
		return errors.New("claude session not initialized")
	}
	turnCtx, turnID := s.turn.Begin(ctx)
	defer s.turn.End(turnID)
	log.Printf("[agent/claude] input session=%s content=%q", s.sessionKey, preview(content))

	waiter := make(chan error, 1)
	s.enqueueTurn(waiter)
	if err := s.stream.Send(turnCtx, content); err != nil {
		s.dequeueTurn(waiter)
		log.Printf("[agent/claude] send.error session=%s err=%v", s.sessionKey, err)
		return err
	}

	select {
	case err := <-waiter:
		if err != nil {
			log.Printf("[agent/claude] send.error session=%s err=%v", s.sessionKey, err)
		}
		return err
	case <-turnCtx.Done():
		s.dequeueTurn(waiter)
		log.Printf("[agent/claude] send.error session=%s err=%v", s.sessionKey, turnCtx.Err())
		return turnCtx.Err()
	}
}

func (s *session) ListModels(ctx context.Context) (types.ModelList, error) {
	_ = ctx
	if s.client == nil {
		return types.ModelList{}, errors.New("claude session not initialized")
	}
	supported := s.client.SupportedModelsFromInit()
	models := make([]types.ModelInfo, 0, len(supported))
	for _, model := range supported {
		name := strings.TrimSpace(model.DisplayName)
		if name == "" {
			name = strings.TrimSpace(model.Value)
		}
		models = append(models, types.ModelInfo{
			ID:          model.Value,
			Name:        name,
			Description: model.Description,
		})
	}
	log.Printf("[agent/claude] models.cached session=%s count=%d", s.sessionKey, len(models))
	return types.ModelList{Models: models}, nil
}

func (s *session) OnUpdate(onUpdate func(types.Event)) {
	s.mu.Lock()
	s.onUpdate = onUpdate
	s.mu.Unlock()
}

func (s *session) SessionID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessionID
}

func (s *session) CancelCurrentTurn() error {
	if s.stream == nil {
		s.turn.Cancel()
		return nil
	}
	if err := s.stream.Interrupt(context.Background()); err == nil {
		return nil
	}
	s.turn.Cancel()
	return nil
}

func (s *session) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		if s.stream != nil {
			closeErr = s.stream.Close()
		}
		if s.client != nil {
			if err := s.client.Close(); err != nil && closeErr == nil {
				closeErr = err
			}
		}
		s.failPendingTurns(errors.New("claude session closed"))
	})
	return closeErr
}

func (s *session) consumeMessages() {
	if s.stream == nil {
		return
	}

	s.sawDelta = false
	s.pendingText.Reset()
	s.pendingThinking.Reset()
	for msg := range s.stream.Messages() {
		s.updateSessionID(msg)

		switch m := msg.(type) {
		case claudeagent.PartialAssistantMessage:
			s.handlePartialAssistantMessage(m.Event)
		case claudeagent.AssistantMessage:
			s.flushAllDeltas()
			s.handleAssistantMessage(m, s.sawDelta)
		case claudeagent.ToolProgressMessage:
			s.flushAllDeltas()
			s.emitToolUpdate(m.ToolUseID, m.ToolName)
		case claudeagent.ResultMessage:
			s.flushAllDeltas()
			log.Printf("[agent/claude] output.done session=%s status=%s subtype=%s", s.sessionKey, m.Status, m.Subtype)
			s.emit(types.Event{Type: types.EventTypeMessageDone, SessionID: s.SessionID()})
			s.completeTurn(resultErr(m))
			s.sawDelta = false
		}
	}

	s.failPendingTurns(errors.New("claude stream ended"))
}

func (s *session) handlePartialAssistantMessage(rawEvent json.RawMessage) {
	textDelta, thinkingDelta := extractDeltas(rawEvent)
	if thinkingDelta != "" {
		s.flushDelta(deltaTypeText)
		s.appendDelta(deltaTypeThinking, thinkingDelta)
	}
	if textDelta != "" {
		s.flushDelta(deltaTypeThinking)
		s.appendDelta(deltaTypeText, textDelta)
	}
}

func (s *session) pendingBuilder(kind deltaType) *strings.Builder {
	if kind == deltaTypeThinking {
		return &s.pendingThinking
	}
	return &s.pendingText
}

func (s *session) flushAllDeltas() {
	s.flushDelta(deltaTypeText)
	s.flushDelta(deltaTypeThinking)
}

func (s *session) flushDelta(kind deltaType) {
	pending := s.pendingBuilder(kind)
	if pending.Len() == 0 {
		return
	}
	delta := pending.String()
	pending.Reset()
	if kind == deltaTypeThinking {
		s.emitThoughtChunk(delta)
		return
	}
	s.sawDelta = true
	s.emitMessageChunk(delta)
}

func (s *session) appendDelta(kind deltaType, delta string) {
	if delta == "" {
		return
	}
	pending := s.pendingBuilder(kind)
	pending.WriteString(delta)
	// Coalesce token-level fragments into readable chunks while keeping streaming feel.
	if pending.Len() >= chunkFlushThreshold || strings.ContainsAny(delta, "\n.!?;:") {
		s.flushDelta(kind)
	}
}

func (s *session) emitThoughtChunk(content string) {
	if strings.TrimSpace(content) == "" {
		return
	}
	s.emit(types.Event{
		Type:      types.EventTypeThoughtChunk,
		SessionID: s.SessionID(),
		Data:      types.ThoughtChunk{Content: content},
	})
}

func (s *session) handleAssistantMessage(msg claudeagent.AssistantMessage, sawDelta bool) {
	for _, block := range msg.Message.Content {
		switch block.Type {
		case "text":
			if sawDelta || strings.TrimSpace(block.Text) == "" {
				continue
			}
			s.emitMessageChunk(block.Text)
		case "thinking":
			s.emitThoughtChunk(block.Text)
		case "tool_use":
			log.Printf("[agent/claude] output.tool_call session=%s tool=%s status=running", s.sessionKey, block.Name)
			s.emit(types.Event{
				Type:      types.EventTypeToolCall,
				SessionID: s.SessionID(),
				Data: types.ToolCall{
					CallID:  block.ID,
					Title:   block.Name,
					Status:  "running",
					Kind:    mapToolKind(block.Name),
					RawType: block.Type,
					Meta: map[string]any{
						"input": string(block.Input),
					},
				},
			})
		}
	}
}

func (s *session) emitMessageChunk(content string) {
	s.emit(types.Event{
		Type:      types.EventTypeMessageChunk,
		SessionID: s.SessionID(),
		Data:      types.MessageChunk{Content: content},
	})
}

func (s *session) emitToolUpdate(callID, name string) {
	log.Printf("[agent/claude] output.tool_update session=%s tool=%s status=running", s.sessionKey, name)
	s.emit(types.Event{
		Type:      types.EventTypeToolUpdate,
		SessionID: s.SessionID(),
		Data: types.ToolCall{
			CallID: callID,
			Title:  name,
			Status: "running",
			Kind:   mapToolKind(name),
		},
	})
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

func (s *session) updateSessionID(msg any) {
	switch m := msg.(type) {
	case claudeagent.SystemMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.AssistantMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.ResultMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.ToolProgressMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.PartialAssistantMessage:
		s.setSessionID(m.SessionID)
	}
}

func (s *session) setSessionID(sessionID string) {
	if strings.TrimSpace(sessionID) == "" {
		return
	}
	s.mu.Lock()
	s.sessionID = sessionID
	s.mu.Unlock()
}

func (s *session) enqueueTurn(waiter chan error) {
	s.turnMu.Lock()
	s.turns = append(s.turns, waiter)
	s.turnMu.Unlock()
}

func (s *session) dequeueTurn(waiter chan error) {
	s.turnMu.Lock()
	defer s.turnMu.Unlock()
	for i, ch := range s.turns {
		if ch != waiter {
			continue
		}
		s.turns = append(s.turns[:i], s.turns[i+1:]...)
		return
	}
}

func (s *session) completeTurn(err error) {
	s.turnMu.Lock()
	if len(s.turns) == 0 {
		s.turnMu.Unlock()
		return
	}
	waiter := s.turns[0]
	s.turns = s.turns[1:]
	s.turnMu.Unlock()

	waiter <- err
}

func (s *session) failPendingTurns(err error) {
	s.turnMu.Lock()
	pending := s.turns
	s.turns = nil
	s.turnMu.Unlock()
	for _, ch := range pending {
		ch <- err
	}
}

func resultErr(msg claudeagent.ResultMessage) error {
	status := strings.ToLower(strings.TrimSpace(msg.Status))
	subtype := strings.ToLower(strings.TrimSpace(msg.Subtype))
	if !msg.IsError && (status == "success" || subtype == "success") && !strings.HasPrefix(subtype, "error") {
		return nil
	}
	if len(msg.Errors) > 0 {
		return errors.New(strings.Join(msg.Errors, "; "))
	}
	if strings.TrimSpace(msg.Result) != "" && strings.EqualFold(msg.Status, "error") {
		return errors.New(msg.Result)
	}
	if strings.TrimSpace(msg.Subtype) != "" {
		return errors.New("claude result: " + msg.Subtype)
	}
	return errors.New("claude turn failed")
}

func extractDeltas(raw json.RawMessage) (string, string) {
	if len(raw) == 0 {
		return "", ""
	}
	var event struct {
		Delta struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"delta"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		return "", ""
	}
	switch strings.TrimSpace(event.Delta.Type) {
	case "text_delta":
		if strings.TrimSpace(event.Delta.Text) != "" {
			return event.Delta.Text, ""
		}
	case "thinking_delta":
		if strings.TrimSpace(event.Delta.Thinking) != "" {
			return "", event.Delta.Thinking
		}
	}
	if strings.TrimSpace(event.Delta.Text) != "" {
		return event.Delta.Text, ""
	}
	if strings.TrimSpace(event.Delta.Thinking) != "" {
		return "", event.Delta.Thinking
	}
	return event.Text, ""
}

func mapToolKind(name string) types.ToolKind {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "read":
		return types.ToolKindRead
	case "edit", "write", "multiedit":
		return types.ToolKindEdit
	case "delete":
		return types.ToolKindDelete
	case "move", "rename":
		return types.ToolKindMove
	case "glob", "grep", "search":
		return types.ToolKindSearch
	case "bash", "execute":
		return types.ToolKindExecute
	case "webfetch", "fetch":
		return types.ToolKindFetch
	case "think":
		return types.ToolKindThink
	case "switchmode":
		return types.ToolKindSwitchMode
	default:
		return types.ToolKindOther
	}
}

func preview(content string) string {
	trimmed := strings.TrimSpace(content)
	if len(trimmed) <= 300 {
		return trimmed
	}
	return trimmed[:300] + "...(truncated)"
}
