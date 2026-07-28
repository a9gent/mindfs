package usecase

import (
	"context"
	"errors"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/apperr"
	"mindfs/server/internal/session"
)

type ListExternalSessionsInput struct {
	RootID      string
	Agent       string
	BeforeTime  time.Time
	AfterTime   time.Time
	Limit       int
	FilterBound bool
}

type ListExternalSessionsOutput struct {
	Items []agenttypes.ExternalSessionSummary `json:"items"`
}

type ImportExternalSessionInput struct {
	RootID         string
	Agent          string
	AgentSessionID string
}

type ImportExternalSessionOutput struct {
	SessionKey     string `json:"session_key"`
	Agent          string `json:"agent"`
	AgentSessionID string `json:"agent_session_id"`
	ImportedCount  int    `json:"imported_count"`
}

type ImportExternalSessionsBatchInput struct {
	RootID          string
	Agent           string
	AgentSessionIDs []string
}

type ImportExternalSessionsBatchItem struct {
	AgentSessionID string `json:"agent_session_id"`
	SessionKey     string `json:"session_key,omitempty"`
	ImportedCount  int    `json:"imported_count,omitempty"`
	Success        bool   `json:"success"`
	Error          string `json:"error,omitempty"`
	ErrorCode      string `json:"error_code,omitempty"`
	ErrorDetail    string `json:"error_detail,omitempty"`
	ErrorPath      string `json:"error_path,omitempty"`
	ErrorOperation string `json:"error_operation,omitempty"`
}

type ImportExternalSessionsBatchOutput struct {
	Items []ImportExternalSessionsBatchItem `json:"items"`
}

type SyncExternalSessionDeltaInput struct {
	RootID string
	Key    string
	Full   bool
}

type SyncExternalSessionDeltaOutput struct {
	ImportedCount int
	LastTimestamp time.Time
}

var externalSessionSyncLocks sync.Map

func (s *Service) ListExternalSessions(ctx context.Context, in ListExternalSessionsInput) (ListExternalSessionsOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ListExternalSessionsOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return ListExternalSessionsOutput{}, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return ListExternalSessionsOutput{}, err
	}
	importer, err := s.resolveExternalSessionImporter(in.Agent)
	if err != nil {
		return ListExternalSessionsOutput{}, err
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 20
	}
	rootPath := normalizeExternalSessionPath(root.RootPath)
	items := make([]agenttypes.ExternalSessionSummary, 0, limit)
	seen := make(map[string]struct{})
	visit := func(item agenttypes.ExternalSessionSummary) (bool, error) {
		if _, ok := seen[item.AgentSessionID]; ok {
			return true, nil
		}
		seen[item.AgentSessionID] = struct{}{}
		if normalizeExternalSessionPath(item.Cwd) != rootPath {
			return true, nil
		}
		firstUserText := strings.TrimSpace(item.FirstUserText)
		if strings.HasPrefix(firstUserText, buildSessionNamePrompt("")) {
			return true, nil
		}
		if in.FilterBound {
			bound, err := manager.HasAgentBinding(ctx, in.Agent, item.AgentSessionID)
			if err != nil {
				return false, err
			}
			if bound {
				return true, nil
			}
		}
		item.FirstUserText = stripExternalSessionPrefix(item.FirstUserText)
		items = append(items, item)
		return len(items) < limit, nil
	}
	if streaming, ok := importer.(agenttypes.StreamingExternalSessionImporter); ok {
		err := streaming.ScanExternalSessions(ctx, agenttypes.ListExternalSessionsInput{
			RootPath:    root.RootPath,
			Agent:       in.Agent,
			BeforeTime:  in.BeforeTime,
			AfterTime:   in.AfterTime,
			Limit:       limit,
			FilterBound: false,
		}, visit)
		if err != nil {
			return ListExternalSessionsOutput{}, err
		}
		return ListExternalSessionsOutput{Items: items}, nil
	}
	result, err := importer.ListExternalSessions(ctx, agenttypes.ListExternalSessionsInput{
		RootPath:    root.RootPath,
		Agent:       in.Agent,
		BeforeTime:  in.BeforeTime,
		AfterTime:   in.AfterTime,
		Limit:       limit,
		FilterBound: false,
	})
	if err != nil {
		return ListExternalSessionsOutput{}, err
	}
	for _, item := range result.Items {
		shouldContinue, err := visit(item)
		if err != nil {
			return ListExternalSessionsOutput{}, err
		}
		if !shouldContinue {
			break
		}
	}
	return ListExternalSessionsOutput{Items: items}, nil
}

func (s *Service) ImportExternalSession(ctx context.Context, in ImportExternalSessionInput) (ImportExternalSessionOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ImportExternalSessionOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return ImportExternalSessionOutput{}, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return ImportExternalSessionOutput{}, err
	}
	importer, err := s.resolveExternalSessionImporter(in.Agent)
	if err != nil {
		return ImportExternalSessionOutput{}, err
	}
	imported, err := importer.ImportExternalSession(ctx, agenttypes.ImportExternalSessionInput{
		RootPath:       root.RootPath,
		Agent:          in.Agent,
		AgentSessionID: in.AgentSessionID,
	})
	if err != nil {
		return ImportExternalSessionOutput{}, err
	}

	name := buildImportedSessionName(imported)
	created, err := manager.Create(ctx, session.CreateInput{
		Type:  session.TypeChat,
		Agent: in.Agent,
		Name:  name,
	})
	if err != nil {
		return ImportExternalSessionOutput{}, err
	}
	for _, exchange := range imported.Exchanges {
		if _, err := appendImportedExchange(ctx, manager, created, in.Agent, exchange); err != nil {
			return ImportExternalSessionOutput{}, err
		}
	}
	current, err := manager.Get(ctx, created.Key, 0)
	if err != nil {
		return ImportExternalSessionOutput{}, err
	}
	importedCount := len(current.Exchanges)
	if err := manager.UpdateAgentState(ctx, created, in.Agent, importedCount, imported.AgentSessionID); err != nil {
		return ImportExternalSessionOutput{}, err
	}
	if _, err := syncImportedSubagentSessions(ctx, manager, created, in.Agent, imported.Subagents); err != nil {
		return ImportExternalSessionOutput{}, err
	}
	return ImportExternalSessionOutput{
		SessionKey:     created.Key,
		Agent:          in.Agent,
		AgentSessionID: imported.AgentSessionID,
		ImportedCount:  importedCount,
	}, nil
}

func (s *Service) ImportExternalSessionsBatch(ctx context.Context, in ImportExternalSessionsBatchInput) (ImportExternalSessionsBatchOutput, error) {
	seen := make(map[string]struct{})
	ids := make([]string, 0, len(in.AgentSessionIDs))
	for _, id := range in.AgentSessionIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return ImportExternalSessionsBatchOutput{}, errors.New("agent_session_ids are required")
	}

	out := ImportExternalSessionsBatchOutput{Items: make([]ImportExternalSessionsBatchItem, 0, len(ids))}
	for _, id := range ids {
		imported, err := s.ImportExternalSession(ctx, ImportExternalSessionInput{
			RootID:         in.RootID,
			Agent:          in.Agent,
			AgentSessionID: id,
		})
		item := ImportExternalSessionsBatchItem{AgentSessionID: id}
		if err != nil {
			item.Success = false
			item.Error = err.Error()
			if appErr, ok := apperr.Classify(err); ok {
				item.ErrorCode = appErr.Code
				item.ErrorDetail = appErr.Detail
				item.ErrorPath = appErr.Path
				item.ErrorOperation = appErr.Op
			}
			out.Items = append(out.Items, item)
			continue
		}
		item.Success = true
		item.SessionKey = imported.SessionKey
		item.ImportedCount = imported.ImportedCount
		out.Items = append(out.Items, item)
	}
	return out, nil
}

func (s *Service) SyncExternalSessionDelta(ctx context.Context, in SyncExternalSessionDeltaInput) (SyncExternalSessionDeltaOutput, error) {
	var out SyncExternalSessionDeltaOutput
	if err := s.ensureRegistry(); err != nil {
		return out, err
	}
	lock := externalSessionSyncLock(in.RootID, in.Key)
	lock.Lock()
	defer lock.Unlock()

	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return out, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return out, err
	}
	current, err := manager.Get(ctx, in.Key, 0)
	if err != nil {
		return out, err
	}
	agentName := session.InferAgentFromSession(current)
	if agentName == "" {
		return out, nil
	}
	binding, err := manager.FindAgentBinding(ctx, current.Key, agentName)
	if err != nil {
		return out, err
	}
	if binding == nil || strings.TrimSpace(binding.AgentSessionID) == "" {
		return out, nil
	}
	lastTimestamp := lastExternalSyncTimestamp(current.Exchanges)
	if lastTimestamp.IsZero() {
		return out, nil
	}
	out.LastTimestamp = lastTimestamp

	importer, err := s.resolveExternalSessionImporter(agentName)
	if err != nil {
		return out, err
	}
	importInput := agenttypes.ImportExternalSessionInput{
		RootPath:       root.RootPath,
		Agent:          agentName,
		AgentSessionID: binding.AgentSessionID,
	}
	if !in.Full {
		importInput.AfterTimestamp = lastTimestamp
	}
	imported, err := importer.ImportExternalSession(ctx, importInput)
	if err != nil {
		return out, err
	}

	delta := imported.Exchanges
	if in.Full {
		delta = externalSessionDeltaAfterCtxSeq(imported.Exchanges, binding.AgentCtxSeq)
	}
	importedCount := 0
	for _, exchange := range delta {
		added, err := appendImportedExchange(ctx, manager, current, agentName, exchange)
		if err != nil {
			return out, err
		}
		if added {
			importedCount++
		}
	}
	latest := current
	if importedCount > 0 {
		latest, err = manager.Get(ctx, current.Key, 0)
		if err != nil {
			return out, err
		}
		agentSessionID := strings.TrimSpace(imported.AgentSessionID)
		if agentSessionID == "" {
			agentSessionID = binding.AgentSessionID
		}
		if err := manager.UpdateAgentState(ctx, latest, agentName, len(latest.Exchanges), agentSessionID); err != nil {
			return out, err
		}
	}
	subagentCount, err := syncImportedSubagentSessions(ctx, manager, latest, agentName, imported.Subagents)
	if err != nil {
		return out, err
	}
	out.ImportedCount = importedCount + subagentCount
	out.LastTimestamp = lastExternalSyncTimestamp(latest.Exchanges)
	if out.ImportedCount > 0 {
		log.Printf("[session/sync] external delta imported root=%s session=%s agent=%s agent_session_id=%s count=%d", strings.TrimSpace(in.RootID), strings.TrimSpace(in.Key), agentName, binding.AgentSessionID, out.ImportedCount)
	}
	return out, nil
}

func syncImportedSubagentSessions(
	ctx context.Context,
	manager *session.Manager,
	rootSession *session.Session,
	agentName string,
	items []agenttypes.ImportedSubagentSession,
) (int, error) {
	if len(items) == 0 {
		return 0, nil
	}
	sessionsByAgentID := make(map[string]*session.Session, len(items))
	pending := append([]agenttypes.ImportedSubagentSession(nil), items...)
	importedCount := 0
	for len(pending) > 0 {
		progressed := false
		next := make([]agenttypes.ImportedSubagentSession, 0, len(pending))
		for _, item := range pending {
			agentSessionID := strings.TrimSpace(item.AgentSessionID)
			if agentSessionID == "" {
				continue
			}
			parent := rootSession
			if parentAgentSessionID := strings.TrimSpace(item.ParentAgentSessionID); parentAgentSessionID != "" {
				parent = sessionsByAgentID[parentAgentSessionID]
				if parent == nil {
					next = append(next, item)
					continue
				}
			}
			binding, err := manager.FindAgentBindingByAgentSession(ctx, agentName, agentSessionID)
			if err != nil {
				return importedCount, err
			}
			var child *session.Session
			start := 0
			if binding == nil {
				name := strings.TrimSpace(item.Title)
				if name == "" {
					name = "Subagent"
				}
				child, err = manager.Create(ctx, session.CreateInput{
					Type:             session.TypeChat,
					ParentSessionKey: parent.Key,
					ParentToolCallID: strings.TrimSpace(item.ParentToolCallID),
					Agent:            agentName,
					Model:            strings.TrimSpace(item.Model),
					Name:             name,
				})
			} else {
				child, err = manager.Get(ctx, binding.SessionKey, 0)
				start = binding.AgentCtxSeq
			}
			if err != nil {
				return importedCount, err
			}
			for _, exchange := range externalSessionDeltaAfterCtxSeq(item.Exchanges, start) {
				added, err := appendImportedExchange(ctx, manager, child, agentName, exchange)
				if err != nil {
					return importedCount, err
				}
				if added {
					importedCount++
				}
			}
			latest, err := manager.Get(ctx, child.Key, 0)
			if err != nil {
				return importedCount, err
			}
			if err := manager.UpdateAgentState(ctx, latest, agentName, len(latest.Exchanges), agentSessionID); err != nil {
				return importedCount, err
			}
			sessionsByAgentID[agentSessionID] = latest
			progressed = true
		}
		if !progressed {
			return importedCount, errors.New("imported subagent parent session not found")
		}
		pending = next
	}
	return importedCount, nil
}

func externalSessionDeltaAfterCtxSeq(exchanges []agenttypes.ImportedExchange, agentCtxSeq int) []agenttypes.ImportedExchange {
	if agentCtxSeq <= 0 {
		return exchanges
	}
	if agentCtxSeq >= len(exchanges) {
		return nil
	}
	return exchanges[agentCtxSeq:]
}

func appendImportedExchange(
	ctx context.Context,
	manager *session.Manager,
	target *session.Session,
	agentName string,
	exchange agenttypes.ImportedExchange,
) (bool, error) {
	role := strings.TrimSpace(exchange.Role)
	if role != "user" && role != "agent" {
		return false, nil
	}
	if role == "user" && strings.TrimSpace(exchange.Content) == "" {
		return false, nil
	}
	if err := manager.AddExchangeForAgentAt(
		ctx,
		target,
		role,
		exchange.Content,
		agentName,
		"",
		"",
		"",
		exchange.Timestamp,
	); err != nil {
		return false, err
	}
	seq := len(target.Exchanges)
	for _, importedAux := range exchange.Aux {
		if importedAux.Plan != nil {
			plan := *importedAux.Plan
			if err := manager.AddExchangeAux(ctx, target.Key, session.ExchangeAux{
				Seq:  seq,
				Line: importedAux.Line,
				Plan: &plan,
			}); err != nil {
				return false, err
			}
			continue
		}
		if importedAux.ToolCall == nil {
			continue
		}
		toolCall := *importedAux.ToolCall
		if toolCall.Kind != agenttypes.ToolKindExecute &&
			toolCall.Kind != agenttypes.ToolKindEdit &&
			toolCall.Kind != agenttypes.ToolKindThink &&
			toolCall.Kind != agenttypes.ToolKindAskUser {
			continue
		}
		if err := manager.AddExchangeAux(ctx, target.Key, session.ExchangeAux{
			Seq:      seq,
			Line:     importedAux.Line,
			ToolCall: &toolCall,
		}); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (s *Service) resolveExternalSessionImporter(agentName string) (agenttypes.ExternalSessionImporter, error) {
	importer, err := s.Registry.GetExternalSessionImporter(strings.TrimSpace(agentName))
	if err != nil {
		return nil, err
	}
	return importer, nil
}

func externalSessionSyncLock(rootID, key string) *sync.Mutex {
	lockKey := strings.TrimSpace(rootID) + ":" + strings.TrimSpace(key)
	lock, _ := externalSessionSyncLocks.LoadOrStore(lockKey, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

func lastExternalSyncTimestamp(exchanges []session.Exchange) time.Time {
	for i := len(exchanges) - 1; i >= 0; i-- {
		if !exchanges[i].Timestamp.IsZero() {
			return exchanges[i].Timestamp.UTC()
		}
	}
	return time.Time{}
}

func buildImportedSessionName(imported agenttypes.ImportedExternalSession) string {
	if title := strings.TrimSpace(imported.Title); title != "" {
		runes := []rune(title)
		if len(runes) > 80 {
			title = string(runes[:80])
		}
		return title
	}
	preview := ""
	for _, item := range imported.Exchanges {
		if item.Role != "user" {
			continue
		}
		preview = strings.TrimSpace(item.Content)
		if preview != "" {
			break
		}
	}
	if preview == "" {
		return "Imported " + strings.TrimSpace(imported.Agent)
	}
	runes := []rune(preview)
	if len(runes) > 40 {
		preview = string(runes[:40])
	}
	return preview
}

func normalizeExternalSessionPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	clean := filepath.Clean(path)
	if resolved, err := filepath.EvalSymlinks(clean); err == nil && strings.TrimSpace(resolved) != "" {
		clean = resolved
	}
	if abs, err := filepath.Abs(clean); err == nil {
		clean = abs
	}
	return filepath.Clean(clean)
}

func stripExternalSessionPrefix(text string) string {
	text = strings.TrimSpace(text)
	const prefix = "This session was migrated from elsewhere. Your context may lag behind this session;"
	const tail = "Only if reading fails, output a brief error and stop."
	normalized := strings.ReplaceAll(text, "\\n", "\n")
	if !strings.HasPrefix(normalized, prefix) {
		return text
	}
	idx := strings.Index(normalized, tail)
	if idx < 0 {
		return text
	}
	return strings.TrimSpace(normalized[idx+len(tail):])
}
