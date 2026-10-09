package usecase

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/session"
)

type EditSessionMessageInput struct {
	RootID            string
	Key               string
	Seq               int
	OriginalContent   string
	OriginalTimestamp time.Time
}

// Let initialization finish before interrupting. Cancelling its context before
// the runtime exists would discard a pending message before it can be persisted.
func InterruptSessionForEdit(rootID, key string) error {
	activeTurnsMu.Lock()
	active := activeTurns[activeTurnKey(rootID, key)]
	var runtime agenttypes.Session
	if active != nil {
		runtime = active.session
	}
	activeTurnsMu.Unlock()
	if runtime == nil {
		return nil
	}
	return runtime.CancelCurrentTurn()
}

// ValidateEditTarget also prevents an old editor from overwriting a newer edit
// which happens to reuse the same sequence number.
func ValidateEditTarget(current *session.Session, in EditSessionMessageInput) (session.Exchange, error) {
	if current == nil || current.Type != session.TypeChat || current.ClosedAt != nil {
		return session.Exchange{}, errors.New("editing requires an open chat session")
	}
	for i := len(current.Exchanges) - 1; i >= 0; i-- {
		e := current.Exchanges[i]
		if e.Role != "user" {
			continue
		}
		if (in.Seq > 0 && e.Seq != in.Seq) || e.Content != in.OriginalContent || !e.Timestamp.Equal(in.OriginalTimestamp) {
			return session.Exchange{}, errors.New("only the latest unchanged user message can be edited; reload the session")
		}
		return e, nil
	}
	return session.Exchange{}, errors.New("user message not found")
}

// PrepareEditedSession runs after the HTTP layer has stopped the current job
// and reserved this session against queued sends. It reuses native fork-point
// resolution without creating a second MindFS session.
func (s *Service) PrepareEditedSession(ctx context.Context, in EditSessionMessageInput) (*session.Session, session.Exchange, error) {
	lock := getSessionSendLock(in.Key)
	lock.Lock()
	defer lock.Unlock()
	syncLock := externalSessionSyncLock(in.RootID, in.Key)
	syncLock.Lock()
	defer syncLock.Unlock()
	m, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, session.Exchange{}, err
	}
	current, err := m.EditSnapshot(in.Key)
	if err != nil {
		return nil, session.Exchange{}, err
	}
	target, err := ValidateEditTarget(current, in)
	if err != nil {
		return nil, target, err
	}
	agentName := strings.TrimSpace(target.Agent)
	if agentName == "" {
		agentName = session.InferAgentFromSession(current)
	}
	pool := s.Registry.GetAgentPool()
	if pool == nil || agentName == "" {
		return nil, target, errors.New("agent unavailable")
	}
	if _, ok := pool.Config().GetAgent(agentName); !ok {
		return nil, target, errors.New("agent not configured")
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return nil, target, err
	}
	var nextBinding *session.AgentBinding
	runtimeRoot := root.RootPath
	if current.RelatedWorktree != nil && current.RelatedWorktree.Path != "" {
		runtimeRoot = current.RelatedWorktree.Path
	}
	// Native agents retain the preceding completed turn. With no preceding
	// turn, sending starts fresh; ACP recovers context from the retained log.
	if !isACPAgent(pool, agentName) {
		previousSeq := 0
		for _, e := range current.Exchanges {
			if e.Seq < target.Seq && isAgentExchangeRole(e.Role) && (e.Agent == agentName || e.Agent == "") {
				previousSeq = e.Seq
			}
		}
		if previousSeq > 0 {
			_, turnIndex, err := resolveForkTarget(current, previousSeq)
			if err != nil {
				return nil, target, err
			}
			binding, err := m.FindAgentBinding(ctx, in.Key, agentName)
			if err != nil {
				return nil, target, err
			}
			if binding == nil {
				return nil, target, errors.New("agent session binding missing")
			}
			importer, err := s.resolveExternalSessionImporter(agentName)
			if err != nil {
				return nil, target, err
			}
			resolver, ok := importer.(agenttypes.ForkPointResolver)
			if !ok {
				return nil, target, errors.New("agent does not support fork points")
			}
			point, err := resolver.ResolveForkPointByAgentTurnIndex(ctx, agenttypes.ResolveForkPointInput{RootPath: runtimeRoot, AgentSessionID: binding.AgentSessionID, AgentTurnIndex: turnIndex})
			if err != nil {
				return nil, target, err
			}
			stagingKey := fmt.Sprintf("edit-%s-%d", in.Key, time.Now().UnixNano())
			staged, err := pool.GetOrCreate(ctx, agenttypes.OpenSessionInput{SessionKey: stagingKey, AgentName: agentName, RootPath: runtimeRoot, Model: target.Model, Mode: target.Mode, Effort: target.Effort, FastService: target.FastService, PlanMode: current.PlanMode, ForkPoint: point})
			if err != nil {
				return nil, target, err
			}
			defer pool.Close(stagingKey)
			id := strings.TrimSpace(staged.SessionID())
			if id == "" {
				return nil, target, errors.New("fork returned no session id")
			}
			nextBinding = &session.AgentBinding{Agent: agentName, AgentSessionID: id, AgentCtxSeq: previousSeq}
		}
	}
	if isACPAgent(pool, agentName) {
		stagingKey := fmt.Sprintf("edit-%s-%d", in.Key, time.Now().UnixNano())
		staged, err := pool.GetOrCreate(ctx, agenttypes.OpenSessionInput{SessionKey: stagingKey, AgentName: agentName, RootPath: runtimeRoot, Model: target.Model, Mode: target.Mode, Effort: target.Effort, PlanMode: current.PlanMode})
		if err != nil {
			return nil, target, err
		}
		defer pool.Close(stagingKey)
		if staged.SessionID() == "" {
			return nil, target, errors.New("new ACP session returned no id")
		}
		nextBinding = &session.AgentBinding{Agent: agentName, AgentSessionID: staged.SessionID(), AgentCtxSeq: 0}
	}
	updated, err := m.ReplaceHistoryBefore(ctx, in.Key, target, nextBinding)
	if err != nil {
		return nil, target, err
	}
	for name := range current.AgentCtxSeq {
		if old, ok := pool.Get(agentPoolSessionKey(in.Key, name)); ok {
			old.OnUpdate(nil)
		}
		pool.Close(agentPoolSessionKey(in.Key, name))
	}
	pool.Close(agentPoolSessionKey(in.Key, agentName))
	target.Agent = agentName
	return updated, target, nil
}
