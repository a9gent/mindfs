package usecase

import (
	"context"

	"mindfs/server/internal/agent"
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

type ResumeSessionInput struct {
	RootID string
	Key    string
}

func (s *Service) ResumeSession(ctx context.Context, in ResumeSessionInput) (*session.Session, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	return manager.Resume(ctx, in.Key)
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
	s.Registry.ReleaseFileWatcher(in.RootID, in.Key)
	return closed, nil
}

type AddExchangeInput struct {
	RootID  string
	Key     string
	Role    string
	Content string
}

func (s *Service) AddExchange(ctx context.Context, in AddExchangeInput) (*session.Session, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	return manager.AddExchange(ctx, in.Key, in.Role, in.Content)
}

type BuildPromptInput struct {
	Session       *session.Session
	Manager       *session.Manager
	Message       string
	ClientContext ctxbuilder.ClientContext
	IsInitial     bool
}

func (s *Service) BuildPrompt(in BuildPromptInput) string {
	if !in.IsInitial {
		return ctxbuilder.BuildUserPrompt(in.Message, ctxbuilder.ClientContext{
			Selection: in.ClientContext.Selection,
		})
	}
	if in.Session == nil || in.Manager == nil {
		return ctxbuilder.BuildUserPrompt(in.Message, in.ClientContext)
	}
	serverCtx, err := ctxbuilder.BuildServerContext(
		in.Session.Type,
		in.Manager.Root(),
		in.ClientContext.CurrentPath,
		in.ClientContext.CurrentView,
		in.Manager,
	)
	if err != nil {
		return ctxbuilder.BuildUserPrompt(in.Message, in.ClientContext)
	}
	systemPrompt := ctxbuilder.BuildSystemPrompt(in.Session.Type, serverCtx)
	userPrompt := ctxbuilder.BuildUserPrompt(in.Message, in.ClientContext)
	if systemPrompt == "" {
		return userPrompt
	}
	return "系统上下文:\n" + systemPrompt + "\n\n用户输入:\n" + userPrompt
}

type AppendAgentReplyInput struct {
	RootID  string
	Key     string
	Content string
}

func (s *Service) AppendAgentReply(ctx context.Context, in AppendAgentReplyInput) error {
	if in.Content == "" {
		return nil
	}
	if err := s.ensureRegistry(); err != nil {
		return err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return err
	}
	_, err = manager.AddExchange(ctx, in.Key, "agent", in.Content)
	return err
}

type SendMessageInput struct {
	RootID    string
	Key       string
	Content   string
	ClientCtx ctxbuilder.ClientContext
	OnUpdate  func(agent.Event)
}

func (s *Service) SendMessage(ctx context.Context, in SendMessageInput) error {
	if err := s.ensureRegistry(); err != nil {
		return err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return err
	}
	before, err := manager.Get(ctx, in.Key)
	if err != nil {
		return err
	}
	isInitial := len(before.Exchanges) == 0
	_, err = manager.AddExchange(ctx, in.Key, "user", in.Content)
	if err != nil {
		return err
	}
	current, err := manager.Get(ctx, in.Key)
	if err != nil {
		return err
	}
	agentPool := s.Registry.GetAgentPool()
	if agentPool == nil {
		return nil
	}
	watcher, _ := s.Registry.GetFileWatcher(in.RootID, manager)
	if watcher != nil {
		watcher.RegisterSession(current.Key)
	}
	root := manager.Root()
	rootAbs, _ := root.RootDir()
	sess, err := agentPool.GetOrCreate(ctx, current.Key, current.Agent, rootAbs)
	if err != nil {
		if prober := s.Registry.GetProber(); prober != nil {
			prober.ReportFailure(current.Agent, err)
		}
		return err
	}

	prompt := s.BuildPrompt(BuildPromptInput{
		Session:       current,
		Manager:       manager,
		Message:       in.Content,
		ClientContext: in.ClientCtx,
		IsInitial:     isInitial,
	})
	var responseText string
	sess.OnUpdate(func(update agent.Event) {
		if update.Type == agent.EventTypeToolCall {
			if toolCall, ok := update.Data.(agent.ToolCall); ok && toolCall.IsWriteOperation() {
				for _, path := range toolCall.GetAffectedPaths() {
					if watcher != nil {
						watcher.RecordPendingWrite(current.Key, path)
						watcher.RecordSessionFile(current.Key, path)
					}
				}
			}
		}
		if update.Type == agent.EventTypeMessageChunk {
			if chunk, ok := update.Data.(agent.MessageChunk); ok {
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
	if err := sess.SendMessage(ctx, prompt); err != nil {
		if prober := s.Registry.GetProber(); prober != nil {
			prober.ReportFailure(current.Agent, err)
		}
		return err
	}
	if prober := s.Registry.GetProber(); prober != nil {
		prober.ReportSuccess(current.Agent)
	}
	return s.AppendAgentReply(ctx, AppendAgentReplyInput{
		RootID:  in.RootID,
		Key:     in.Key,
		Content: responseText,
	})
}
