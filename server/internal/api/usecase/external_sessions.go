package usecase

import (
	"context"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
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

type SyncExternalSessionDeltaInput struct {
	RootID string
	Key    string
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
	beforeTime := in.BeforeTime
	for len(items) < limit {
		batchLimit := externalSessionBatchLimit(limit, len(items))
		result, err := importer.ListExternalSessions(ctx, agenttypes.ListExternalSessionsInput{
			RootPath:    root.RootPath,
			Agent:       in.Agent,
			BeforeTime:  beforeTime,
			AfterTime:   in.AfterTime,
			Limit:       batchLimit,
			FilterBound: false,
		})
		if err != nil {
			return ListExternalSessionsOutput{}, err
		}
		if len(result.Items) == 0 {
			break
		}
		for _, item := range result.Items {
			if _, ok := seen[item.AgentSessionID]; ok {
				continue
			}
			seen[item.AgentSessionID] = struct{}{}
			if normalizeExternalSessionPath(item.Cwd) != rootPath {
				continue
			}
			firstUserText := strings.TrimSpace(item.FirstUserText)
			if strings.HasPrefix(firstUserText, buildSessionNamePrompt("")) {
				continue
			}
			if in.FilterBound {
				bound, err := manager.HasAgentBinding(ctx, in.Agent, item.AgentSessionID)
				if err != nil {
					return ListExternalSessionsOutput{}, err
				}
				if bound {
					continue
				}
			}
			item.FirstUserText = stripExternalSessionPrefix(item.FirstUserText)
			items = append(items, item)
			if len(items) >= limit {
				break
			}
		}
		if len(result.Items) < batchLimit {
			break
		}
		oldest := result.Items[len(result.Items)-1].UpdatedAt
		if oldest.IsZero() {
			break
		}
		beforeTime = oldest
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
		role := strings.TrimSpace(exchange.Role)
		if role != "user" && role != "agent" {
			continue
		}
		if err := manager.AddExchangeForAgentAt(ctx, created, role, exchange.Content, in.Agent, "", "", exchange.Timestamp); err != nil {
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
	return ImportExternalSessionOutput{
		SessionKey:     created.Key,
		Agent:          in.Agent,
		AgentSessionID: imported.AgentSessionID,
		ImportedCount:  importedCount,
	}, nil
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
	imported, err := importer.ImportExternalSession(ctx, agenttypes.ImportExternalSessionInput{
		RootPath:       root.RootPath,
		Agent:          agentName,
		AgentSessionID: binding.AgentSessionID,
		AfterTimestamp: lastTimestamp,
	})
	if err != nil {
		return out, err
	}

	importedCount := 0
	for _, exchange := range imported.Exchanges {
		role := strings.TrimSpace(exchange.Role)
		if role != "user" && role != "agent" {
			continue
		}
		if exchange.Timestamp.IsZero() || !exchange.Timestamp.After(lastTimestamp) {
			continue
		}
		if err := manager.AddExchangeForAgentAt(ctx, current, role, exchange.Content, agentName, "", "", exchange.Timestamp); err != nil {
			return out, err
		}
		importedCount++
	}
	if importedCount == 0 {
		return out, nil
	}

	latest, err := manager.Get(ctx, current.Key, 0)
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
	out.ImportedCount = importedCount
	out.LastTimestamp = lastExternalSyncTimestamp(latest.Exchanges)
	log.Printf("[session/sync] external delta imported root=%s session=%s agent=%s agent_session_id=%s count=%d", strings.TrimSpace(in.RootID), strings.TrimSpace(in.Key), agentName, agentSessionID, importedCount)
	return out, nil
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

func externalSessionBatchLimit(limit, collected int) int {
	remaining := limit - collected
	if remaining < 20 {
		remaining = 20
	}
	if remaining < limit {
		return limit
	}
	return remaining
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
