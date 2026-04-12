package acp

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	agenttypes "mindfs/server/internal/agent/types"
)

type ImporterOptions struct {
	AgentName  string
	Command    string
	Args       []string
	Env        map[string]string
	ResolveCwd func(rootPath string) string
}

type Importer struct {
	agentName  string
	command    string
	args       []string
	env        map[string]string
	resolveCwd func(rootPath string) string
}

type importCollector struct {
	mu        sync.Mutex
	exchanges []agenttypes.ImportedExchange
}

func NewImporter(opts ImporterOptions) *Importer {
	return &Importer{
		agentName:  strings.TrimSpace(opts.AgentName),
		command:    strings.TrimSpace(opts.Command),
		args:       append([]string{}, opts.Args...),
		env:        cloneEnv(opts.Env),
		resolveCwd: opts.ResolveCwd,
	}
}

func (i *Importer) AgentName() string {
	return i.agentName
}

func (i *Importer) ListExternalSessions(ctx context.Context, in agenttypes.ListExternalSessionsInput) (agenttypes.ListExternalSessionsResult, error) {
	proc, cwd, err := i.openProcess(ctx, in.RootPath)
	if err != nil {
		return agenttypes.ListExternalSessionsResult{}, err
	}
	defer proc.Close()

	limit := in.Limit
	if limit <= 0 {
		limit = 20
	}
	items := make([]agenttypes.ExternalSessionSummary, 0, limit)
	var cursor *string
	for {
		resp, err := proc.conn.UnstableListSessions(ctx, acpsdk.UnstableListSessionsRequest{
			Cursor: cursor,
			Cwd:    &cwd,
		})
		if err != nil {
			return agenttypes.ListExternalSessionsResult{}, err
		}
		for _, item := range resp.Sessions {
			if normalizeComparablePath(item.Cwd) != normalizeComparablePath(cwd) {
				continue
			}
			updatedAt := parseTimeStringPtr(item.UpdatedAt)
			if !in.BeforeTime.IsZero() && !updatedAt.Before(in.BeforeTime) {
				continue
			}
			if !in.AfterTime.IsZero() && !updatedAt.After(in.AfterTime) {
				continue
			}
			firstUserText := ""
			if item.Title != nil {
				firstUserText = strings.TrimSpace(*item.Title)
			}
			items = append(items, agenttypes.ExternalSessionSummary{
				Agent:          i.agentName,
				AgentSessionID: string(item.SessionId),
				Cwd:            item.Cwd,
				FirstUserText:  firstUserText,
				UpdatedAt:      updatedAt,
			})
			if len(items) >= limit {
				return agenttypes.ListExternalSessionsResult{Items: items}, nil
			}
		}
		if resp.NextCursor == nil || strings.TrimSpace(*resp.NextCursor) == "" {
			break
		}
		next := strings.TrimSpace(*resp.NextCursor)
		cursor = &next
	}
	return agenttypes.ListExternalSessionsResult{Items: items}, nil
}

func (i *Importer) ImportExternalSession(ctx context.Context, in agenttypes.ImportExternalSessionInput) (agenttypes.ImportedExternalSession, error) {
	proc, cwd, err := i.openProcess(ctx, in.RootPath)
	if err != nil {
		return agenttypes.ImportedExternalSession{}, err
	}
	defer proc.Close()

	sessionID := strings.TrimSpace(in.AgentSessionID)
	if sessionID == "" {
		return agenttypes.ImportedExternalSession{}, errors.New("agent session id required")
	}

	collector := &importCollector{}
	if err := proc.attachImportCollector(sessionID, collector); err != nil {
		return agenttypes.ImportedExternalSession{}, err
	}
	defer proc.detachImportCollector(sessionID)

	_, err = proc.conn.LoadSession(ctx, acpsdk.LoadSessionRequest{
		Cwd:        cwd,
		McpServers: []acpsdk.McpServer{},
		SessionId:  acpsdk.SessionId(sessionID),
	})
	if err != nil {
		return agenttypes.ImportedExternalSession{}, err
	}
	return agenttypes.ImportedExternalSession{
		Agent:          i.agentName,
		AgentSessionID: sessionID,
		Cwd:            cwd,
		Exchanges:      collector.snapshot(),
	}, nil
}

func (i *Importer) openProcess(ctx context.Context, rootPath string) (*Process, string, error) {
	if strings.TrimSpace(i.command) == "" {
		return nil, "", errors.New("agent command required")
	}
	cwd := strings.TrimSpace(rootPath)
	if i.resolveCwd != nil {
		cwd = strings.TrimSpace(i.resolveCwd(rootPath))
	}
	if cwd == "" {
		return nil, "", errors.New("root path required")
	}
	proc, err := Start(ctx, i.agentName, i.command, i.args, cwd, i.env)
	if err != nil {
		return nil, "", err
	}
	if err := proc.Initialize(ctx); err != nil {
		proc.Close()
		return nil, "", err
	}
	return proc, cwd, nil
}

func (p *Process) attachImportCollector(sessionID string, collector *importCollector) error {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return errors.New("session id required")
	}
	if collector == nil {
		return errors.New("collector required")
	}
	state := &sessionState{
		ID: acpsdk.SessionId(sessionID),
	}
	state.setOnUpdate(func(update SessionUpdate) {
		collector.handle(update)
	})
	p.mu.Lock()
	p.sessionsByID[sessionID] = state
	p.mu.Unlock()
	return nil
}

func (p *Process) detachImportCollector(sessionID string) {
	p.mu.Lock()
	delete(p.sessionsByID, strings.TrimSpace(sessionID))
	p.mu.Unlock()
}

func (c *importCollector) handle(update SessionUpdate) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case update.Raw.UserMessageChunk != nil && update.Raw.UserMessageChunk.Content.Text != nil:
		c.append("user", update.Raw.UserMessageChunk.Content.Text.Text)
	case update.Raw.AgentMessageChunk != nil && update.Raw.AgentMessageChunk.Content.Text != nil:
		c.append("agent", update.Raw.AgentMessageChunk.Content.Text.Text)
	}
}

func (c *importCollector) append(role, content string) {
	content = strings.TrimSpace(content)
	if content == "" {
		return
	}
	if role == "agent" && len(c.exchanges) > 0 && c.exchanges[len(c.exchanges)-1].Role == role {
		last := &c.exchanges[len(c.exchanges)-1]
		last.Content = strings.TrimSpace(last.Content + content)
		last.Timestamp = time.Now().UTC()
		return
	}
	c.exchanges = append(c.exchanges, agenttypes.ImportedExchange{
		Role:      role,
		Content:   content,
		Timestamp: time.Now().UTC(),
	})
}

func (c *importCollector) snapshot() []agenttypes.ImportedExchange {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]agenttypes.ImportedExchange, len(c.exchanges))
	copy(out, c.exchanges)
	return out
}

func parseTimeStringPtr(raw *string) time.Time {
	if raw == nil {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(*raw))
	if err != nil {
		return time.Time{}
	}
	return parsed.UTC()
}

func cloneEnv(env map[string]string) map[string]string {
	if len(env) == 0 {
		return nil
	}
	out := make(map[string]string, len(env))
	for key, value := range env {
		out[key] = value
	}
	return out
}

func normalizeComparablePath(path string) string {
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
