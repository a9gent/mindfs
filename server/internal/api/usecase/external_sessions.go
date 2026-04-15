package usecase

import (
	"context"
	"path/filepath"
	"strings"
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
		if err := manager.AddExchangeForAgent(ctx, created, role, exchange.Content, in.Agent, ""); err != nil {
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

func (s *Service) resolveExternalSessionImporter(agentName string) (agenttypes.ExternalSessionImporter, error) {
	importer, err := s.Registry.GetExternalSessionImporter(strings.TrimSpace(agentName))
	if err != nil {
		return nil, err
	}
	return importer, nil
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
