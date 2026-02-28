package usecase

import (
	"context"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	ctxbuilder "mindfs/server/internal/context"
	"mindfs/server/internal/session"
)

type ListSessionsInput struct {
	RootID string
}

type ListSessionsOutput struct {
	Sessions []*session.Session
}

func (s *Service) ListSessions(ctx context.Context, in ListSessionsInput) (ListSessionsOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ListSessionsOutput{}, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return ListSessionsOutput{}, err
	}
	items, err := manager.List(ctx)
	if err != nil {
		return ListSessionsOutput{}, err
	}
	return ListSessionsOutput{Sessions: items}, nil
}

type CreateSessionInput struct {
	RootID string
	Input  session.CreateInput
}

func (s *Service) CreateSession(ctx context.Context, in CreateSessionInput) (*session.Session, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	return manager.Create(ctx, in.Input)
}

type GetSessionInput struct {
	RootID string
	Key    string
}

func (s *Service) GetSession(ctx context.Context, in GetSessionInput) (*session.Session, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	return manager.Get(ctx, in.Key)
}

type CloseSessionInput struct {
	RootID string
	Key    string
}

func (s *Service) CloseSession(ctx context.Context, in CloseSessionInput) (*session.Session, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	closed, err := manager.Close(ctx, in.Key)
	if err != nil {
		return nil, err
	}
	if pool := s.Registry.GetAgentPool(); pool != nil && closed != nil {
		for agentName := range closed.AgentCtxSeq {
			pool.Close(agentPoolSessionKey(closed.Key, agentName))
		}
	}
	s.Registry.ReleaseFileWatcher(in.RootID, in.Key)
	return closed, nil
}

type BuildPromptInput struct {
	Session       *session.Session
	Manager       *session.Manager
	Agent         string
	Message       string
	ClientContext ctxbuilder.ClientContext
	IsInitial     bool
}

func (s *Service) BuildPrompt(in BuildPromptInput) string {
	prompt := ""
	if !in.IsInitial {
		prompt = ctxbuilder.BuildUserPrompt(in.Message, ctxbuilder.ClientContext{
			Selection: in.ClientContext.Selection,
		})
		return prependSwitchHint(in, prompt)
	}
	if in.Session == nil || in.Manager == nil {
		prompt = ctxbuilder.BuildUserPrompt(in.Message, in.ClientContext)
		return prependSwitchHint(in, prompt)
	}
	serverCtx, err := ctxbuilder.BuildServerContext(
		in.Session.Type,
		in.Manager.Root(),
		in.ClientContext.CurrentView,
	)
	if err != nil {
		prompt = ctxbuilder.BuildUserPrompt(in.Message, in.ClientContext)
		return prependSwitchHint(in, prompt)
	}
	serverPrompt := ctxbuilder.BuildServerPrompt(in.Session.Type, serverCtx)
	userPrompt := ctxbuilder.BuildUserPrompt(in.Message, in.ClientContext)
	if serverPrompt == "" {
		prompt = userPrompt
		return prependSwitchHint(in, prompt)
	}
	prompt = serverPrompt + "\n\n" + userPrompt
	return prependSwitchHint(in, prompt)
}

func prependSwitchHint(in BuildPromptInput, prompt string) string {
	if in.Session == nil || in.Manager == nil {
		return prompt
	}
	currentAgent := strings.TrimSpace(in.Agent)
	if currentAgent == "" {
		return prompt
	}
	total := contextLineCount(in.Session.Exchanges)
	last := in.Session.AgentCtxSeq[currentAgent]
	linesToRead := calculateSwitchReadLines(total, last)
	if linesToRead <= 0 {
		return prompt
	}
	log.Printf("[session/send] context_hint apply session=%s agent=%s total=%d last=%d read_lines=%d", in.Session.Key, currentAgent, total, last, linesToRead)
	logPath := in.Manager.ExchangeLogPath(in.Session.Key)
	readHint := buildSwitchReadHint(logPath, linesToRead)
	return readHint + prompt
}

func (s *Service) appendAgentReply(ctx context.Context, manager *session.Manager, sess *session.Session, agent, content string) error {
	if content == "" {
		return nil
	}
	if manager == nil {
		return nil
	}
	return manager.AddExchangeForAgent(ctx, sess, "agent", content, agent)
}

type SendMessageInput struct {
	RootID    string
	Key       string
	Agent     string
	Content   string
	ClientCtx ctxbuilder.ClientContext
	OnUpdate  func(agenttypes.Event)
}

const switchContextTailLines = 20

var (
	sessionSendLocksMu sync.Mutex
	sessionSendLocks   = make(map[string]*sync.Mutex)
)

func getSessionSendLock(sessionKey string) *sync.Mutex {
	sessionSendLocksMu.Lock()
	defer sessionSendLocksMu.Unlock()
	lock := sessionSendLocks[sessionKey]
	if lock == nil {
		lock = &sync.Mutex{}
		sessionSendLocks[sessionKey] = lock
	}
	return lock
}

func agentPoolSessionKey(sessionKey, agentName string) string {
	trimmedSessionKey := strings.TrimSpace(sessionKey)
	if trimmedSessionKey == "" {
		return ""
	}
	trimmedAgent := strings.TrimSpace(agentName)
	if trimmedAgent == "" {
		return trimmedSessionKey
	}
	return strings.ToLower(trimmedAgent) + "-" + trimmedSessionKey
}

func calculateSwitchReadLines(total, lastCtxSeq int) int {
	lines := total - lastCtxSeq
	if lines < 0 {
		return 0
	}
	if lines > switchContextTailLines {
		return switchContextTailLines
	}
	return lines
}

func buildSwitchReadHint(exchangeLogPath string, lines int) string {
	return "This session was migrated from elsewhere. Your context may lag behind this session;\n" +
		"Before replying, read the last " + strconv.Itoa(lines) + " lines from " + exchangeLogPath + " to recover context.\n" +
		"If you still need more context, decide and read older history yourself.\n" +
		"When continuing to read, keep each backward batch to about " + strconv.Itoa(switchContextTailLines) + " lines.\n\n" +
		"Execution order: read history first, then compose the final answer.\n" +
		"Note: do not send any natural-language response before finishing the required history reads. Start reading immediately via tools/commands.\n" +
		"Only if reading fails, output a brief error and stop.\n\n"
}

func contextLineCount(exchanges []session.Exchange) int {
	return len(exchanges)
}

func (s *Service) ensureAgentSession(
	ctx context.Context,
	pool *agent.Pool,
	current *session.Session,
	agentName string,
	rootAbs string,
) (agenttypes.Session, error) {
	poolSessionKey := agentPoolSessionKey(current.Key, agentName)
	if existing, ok := pool.Get(poolSessionKey); ok {
		return existing, nil
	}

	openInput := agenttypes.OpenSessionInput{
		SessionKey: poolSessionKey,
		AgentName:  agentName,
		RootPath:   rootAbs,
	}
	sess, err := pool.GetOrCreate(ctx, openInput)
	if err != nil {
		if prober := s.Registry.GetProber(); prober != nil {
			prober.ReportFailure(agentName, err)
		}
		return nil, err
	}
	return sess, nil
}

func (s *Service) SendMessage(ctx context.Context, in SendMessageInput) error {
	start := time.Now()
	log.Printf("[session/send] begin root=%s session=%s content_chars=%d", in.RootID, in.Key, len(in.Content))
	if err := s.ensureRegistry(); err != nil {
		return err
	}
	sendLock := getSessionSendLock(in.Key)
	sendLock.Lock()
	defer sendLock.Unlock()
	t0 := time.Now()
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return err
	}
	log.Printf("[session/send] get_manager session=%s duration_ms=%d", in.Key, time.Since(t0).Milliseconds())
	t1 := time.Now()
	current, err := manager.Get(ctx, in.Key)
	if err != nil {
		return err
	}
	log.Printf("[session/send] load_session_before session=%s duration_ms=%d", in.Key, time.Since(t1).Milliseconds())
	isInitial := len(current.Exchanges) == 0
	agentPool := s.Registry.GetAgentPool()
	if agentPool == nil {
		return nil
	}
	t4 := time.Now()
	watcher, watcherErr := s.Registry.GetFileWatcher(in.RootID, manager)
	if watcherErr != nil {
		log.Printf("[watcher] root=%s session=%s get_failed err=%v", in.RootID, current.Key, watcherErr)
	}
	if watcher != nil {
		watcher.RegisterSession(current.Key)
		watcher.MarkSessionActive(current.Key)
	} else {
		log.Printf("[watcher] root=%s session=%s unavailable", in.RootID, current.Key)
	}
	log.Printf("[session/send] prepare_watcher session=%s duration_ms=%d", in.Key, time.Since(t4).Milliseconds())
	root := manager.Root()
	rootAbs, _ := root.RootDir()
	t5 := time.Now()
	sess, err := s.ensureAgentSession(ctx, agentPool, current, in.Agent, rootAbs)
	if err != nil {
		return err
	}
	log.Printf("[session/send] get_or_create_agent_session session=%s agent=%s duration_ms=%d", in.Key, in.Agent, time.Since(t5).Milliseconds())

	t6 := time.Now()
	prompt := s.BuildPrompt(BuildPromptInput{
		Session:       current,
		Manager:       manager,
		Agent:         in.Agent,
		Message:       in.Content,
		ClientContext: in.ClientCtx,
		IsInitial:     isInitial,
	})
	log.Printf("[session/send] build_prompt session=%s prompt_chars=%d duration_ms=%d", in.Key, len(prompt), time.Since(t6).Milliseconds())
	var responseText string
	sess.OnUpdate(func(update agenttypes.Event) {
		if update.Type == agenttypes.EventTypeToolCall {
			if toolCall, ok := update.Data.(agenttypes.ToolCall); ok && toolCall.IsWriteOperation() {
				for _, path := range toolCall.GetAffectedPaths() {
					if watcher != nil {
						watcher.RecordPendingWrite(current.Key, path)
						watcher.RecordSessionFile(current.Key, path)
					}
				}
			}
		}
		if update.Type == agenttypes.EventTypeMessageChunk {
			if chunk, ok := update.Data.(agenttypes.MessageChunk); ok {
				responseText += chunk.Content
			}
		}
		if watcher != nil {
			watcher.MarkSessionActive(current.Key)
		}
		if in.OnUpdate != nil {
			in.OnUpdate(update)
		}
	})
	t7 := time.Now()
	sendErr := sess.SendMessage(ctx, prompt)
	log.Printf("[session/send] agent_send_message_done session=%s duration_ms=%d", in.Key, time.Since(t7).Milliseconds())
	t8 := time.Now()
	if err := manager.AddExchangeForAgent(ctx, current, "user", in.Content, in.Agent); err != nil {
		return err
	}
	log.Printf("[session/send] append_user_exchange session=%s duration_ms=%d", in.Key, time.Since(t8).Milliseconds())
	if sendErr != nil {
		if prober := s.Registry.GetProber(); prober != nil {
			prober.ReportFailure(in.Agent, sendErr)
		}
		return sendErr
	}
	if prober := s.Registry.GetProber(); prober != nil {
		prober.ReportSuccess(in.Agent)
	}
	t9 := time.Now()
	err = s.appendAgentReply(ctx, manager, current, in.Agent, responseText)
	log.Printf("[session/send] append_agent_reply session=%s duration_ms=%d", in.Key, time.Since(t9).Milliseconds())
	if err != nil {
		return err
	}

	_ = manager.UpdateAgentState(ctx, current, in.Agent, contextLineCount(current.Exchanges))
	log.Printf("[session/send] done root=%s session=%s total_ms=%d", in.RootID, in.Key, time.Since(start).Milliseconds())
	return nil
}
