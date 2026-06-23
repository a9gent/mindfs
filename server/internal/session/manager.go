package session

import (
	"bufio"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	agenttypes "mindfs/server/internal/agent/types"
	configpkg "mindfs/server/internal/config"
	"mindfs/server/internal/fs"

	_ "modernc.org/sqlite"
)

const (
	sessionDBPath    = "sessions/session-list.db"
	sessionDBLinkExt = ".link"
	exchangeFileTpl  = "sessions/%s.jsonl"
	auxFileTpl       = "sessions/%s.aux.jsonl"
	selectSessionSQL = `
	SELECT key, type, parent_session_key, parent_tool_call_id, source, model, shell, plan_mode, name, related_files_json, created_at, updated_at, closed_at
	FROM sessions`
	deleteSessionSQL = `
DELETE FROM sessions
WHERE key = ?`
	deleteBindingsBySessionSQL = `
DELETE FROM session_agent_bindings
WHERE session_key = ?`
	upsertSessionMetaSQL = `
INSERT INTO sessions (
		key, type, parent_session_key, parent_tool_call_id, source, model, shell, plan_mode, name, related_files_json, created_at, updated_at, closed_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
	type = excluded.type,
	parent_session_key = excluded.parent_session_key,
		parent_tool_call_id = excluded.parent_tool_call_id,
		source = excluded.source,
		model = excluded.model,
		shell = excluded.shell,
		plan_mode = excluded.plan_mode,
		name = excluded.name,
	related_files_json = excluded.related_files_json,
	created_at = excluded.created_at,
	updated_at = excluded.updated_at,
	closed_at = excluded.closed_at`
	sessionTableSchema = `
CREATE TABLE IF NOT EXISTS sessions (
	key TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	parent_session_key TEXT NOT NULL DEFAULT '',
	parent_tool_call_id TEXT NOT NULL DEFAULT '',
	source TEXT NOT NULL DEFAULT '',
		model TEXT NOT NULL DEFAULT '',
		shell TEXT NOT NULL DEFAULT '',
		plan_mode INTEGER NOT NULL DEFAULT 0,
		name TEXT NOT NULL,
	related_files_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	closed_at TEXT
);`
	agentBindingTableSchema = `
CREATE TABLE IF NOT EXISTS session_agent_bindings (
	session_key TEXT NOT NULL,
	agent TEXT NOT NULL,
	agent_session_id TEXT NOT NULL,
	agent_ctx_seq INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (session_key, agent)
);`
	upsertAgentBindingSQL = `
INSERT INTO session_agent_bindings (
	session_key, agent, agent_session_id, agent_ctx_seq
) VALUES (?, ?, ?, ?)
ON CONFLICT(session_key, agent) DO UPDATE SET
	agent_session_id = excluded.agent_session_id,
	agent_ctx_seq = excluded.agent_ctx_seq`
	selectAgentBindingSQL = `
SELECT session_key, agent, agent_session_id, agent_ctx_seq
FROM session_agent_bindings
WHERE session_key = ? AND agent = ?`
	selectAgentBindingsBySessionSQL = `
SELECT session_key, agent, agent_session_id, agent_ctx_seq
FROM session_agent_bindings
WHERE session_key = ?`
	selectBindingByAgentSessionSQL = `
SELECT session_key, agent, agent_session_id, agent_ctx_seq
FROM session_agent_bindings
WHERE agent = ? AND agent_session_id = ?
LIMIT 1`
)

var openSQLiteDB = func(path string) (*sql.DB, error) {
	return sql.Open("sqlite", path)
}

var mindFSConfigDir = configpkg.MindFSConfigDir

type Manager struct {
	root             fs.RootInfo
	mu               sync.Mutex
	loopOnce         sync.Once
	db               *sql.DB
	sessions         map[string]*Session
	pendingToolCalls map[string]map[string]agenttypes.ToolCall
	now              func() time.Time
	idleInterval     time.Duration
	idleFor          time.Duration
	closeFor         time.Duration
	maxIdleSessions  int
}

type CreateInput struct {
	Key              string
	Type             string
	ParentSessionKey string
	ParentToolCallID string
	Source           string
	Agent            string
	Model            string
	Shell            string
	PlanMode         bool
	Name             string
}

type AgentBinding struct {
	SessionKey     string `json:"session_key"`
	Agent          string `json:"agent"`
	AgentSessionID string `json:"agent_session_id"`
	AgentCtxSeq    int    `json:"agent_ctx_seq"`
}

type ListOptions struct {
	BeforeTime time.Time
	AfterTime  time.Time
	Limit      int
}

func NewManager(root fs.RootInfo, opts ...Option) *Manager {
	m := &Manager{
		root:             root,
		sessions:         make(map[string]*Session),
		pendingToolCalls: make(map[string]map[string]agenttypes.ToolCall),
		now:              time.Now,
		idleInterval:     1 * time.Minute,
		idleFor:          10 * time.Minute,
		closeFor:         7 * 24 * time.Hour,
		maxIdleSessions:  3,
	}
	for _, opt := range opts {
		opt(m)
	}
	return m
}

type Option func(*Manager)

func WithClock(now func() time.Time) Option {
	return func(m *Manager) {
		m.now = now
	}
}

func WithIdlePolicy(interval, idleFor, closeFor time.Duration, maxIdleSessions int) Option {
	return func(m *Manager) {
		if interval > 0 {
			m.idleInterval = interval
		}
		if idleFor > 0 {
			m.idleFor = idleFor
		}
		if closeFor > 0 {
			m.closeFor = closeFor
		}
		if maxIdleSessions > 0 {
			m.maxIdleSessions = maxIdleSessions
		}
	}
}

func (m *Manager) Create(_ context.Context, input CreateInput) (*Session, error) {
	if strings.TrimSpace(input.Type) == "" {
		return nil, errors.New("session type required")
	}
	key := input.Key
	if key == "" {
		key = generateKey()
	}
	now := m.now().UTC()
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = "New Session"
	}
	initialAgent := strings.TrimSpace(input.Agent)
	agentCtxSeq := map[string]int{}
	if initialAgent != "" {
		agentCtxSeq[initialAgent] = 0
	}
	session := &Session{
		Key:              key,
		Type:             input.Type,
		ParentSessionKey: strings.TrimSpace(input.ParentSessionKey),
		ParentToolCallID: strings.TrimSpace(input.ParentToolCallID),
		Source:           strings.TrimSpace(input.Source),
		AgentCtxSeq:      agentCtxSeq,
		Model:            strings.TrimSpace(input.Model),
		Shell:            strings.TrimSpace(input.Shell),
		PlanMode:         input.PlanMode,
		Name:             name,
		Exchanges:        []Exchange{},
		RelatedFiles:     []RelatedFile{},
		CreatedAt:        now,
		UpdatedAt:        now,
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.createSessionUnsafe(session); err != nil {
		return nil, err
	}
	m.sessions[session.Key] = session
	return session, nil
}

func (m *Manager) Get(_ context.Context, key string, afterSeq int) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.getSessionUnsafe(key, afterSeq)
}

func (m *Manager) GetExchangeAux(_ context.Context, key string, afterSeq int) (map[int][]ExchangeAux, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.loadExchangeAux(key, afterSeq)
}

func (m *Manager) GetFullToolCall(_ context.Context, key, callID string) (*agenttypes.ToolCall, error) {
	if strings.TrimSpace(key) == "" {
		return nil, errors.New("session key required")
	}
	callID = strings.TrimSpace(callID)
	if callID == "" {
		return nil, errors.New("tool call id required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if found, ok := m.pendingFullToolCallUnsafe(key, callID); ok {
		return found, nil
	}
	aux, err := m.loadExchangeAuxEntries(key, 0)
	if err != nil {
		return nil, err
	}
	var found *agenttypes.ToolCall
	for _, item := range aux {
		if item.ToolCall == nil || strings.TrimSpace(item.ToolCall.CallID) != callID {
			continue
		}
		next := *item.ToolCall
		if found == nil {
			found = &next
			continue
		}
		merged := mergeToolCall(*found, next)
		found = &merged
	}
	if found == nil {
		return nil, os.ErrNotExist
	}
	return found, nil
}

func (m *Manager) UpsertPendingExchangeAux(_ context.Context, sessionKey string, aux ExchangeAux) error {
	sessionKey = strings.TrimSpace(sessionKey)
	if sessionKey == "" {
		return errors.New("session key required")
	}
	if aux.ToolCall == nil || strings.TrimSpace(aux.ToolCall.CallID) == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pendingToolCalls == nil {
		m.pendingToolCalls = make(map[string]map[string]agenttypes.ToolCall)
	}
	callID := strings.TrimSpace(aux.ToolCall.CallID)
	next := cloneToolCall(*aux.ToolCall)
	byCallID := m.pendingToolCalls[sessionKey]
	if byCallID == nil {
		byCallID = make(map[string]agenttypes.ToolCall)
		m.pendingToolCalls[sessionKey] = byCallID
	}
	if existing, ok := byCallID[callID]; ok {
		next = mergeToolCall(existing, next)
	}
	byCallID[callID] = next
	return nil
}

func (m *Manager) MarkPendingAskUserAnswered(_ context.Context, sessionKey, callID string, answers map[string]string, answeredAt time.Time) error {
	sessionKey = strings.TrimSpace(sessionKey)
	if sessionKey == "" {
		return errors.New("session key required")
	}
	callID = strings.TrimSpace(callID)
	if callID == "" {
		return errors.New("tool call id required")
	}
	cleanAnswers := make(map[string]string, len(answers))
	for key, value := range answers {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key != "" && value != "" {
			cleanAnswers[key] = value
		}
	}
	if len(cleanAnswers) == 0 {
		return errors.New("answers required")
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pendingToolCalls == nil || m.pendingToolCalls[sessionKey] == nil {
		return errors.New("pending tool call not found")
	}
	existing, ok := m.pendingToolCalls[sessionKey][callID]
	if !ok {
		return errors.New("pending tool call not found")
	}
	if existing.Kind != "" && existing.Kind != agenttypes.ToolKindAskUser {
		return errors.New("pending tool call is not ask_user")
	}
	meta := make(map[string]any, len(existing.Meta)+2)
	for key, value := range existing.Meta {
		meta[key] = value
	}
	meta["answers"] = cleanAnswers
	if !answeredAt.IsZero() {
		meta["answeredAt"] = answeredAt.UTC().Format(time.RFC3339Nano)
	}
	existing.Kind = agenttypes.ToolKindAskUser
	existing.Status = "complete"
	existing.Meta = meta
	m.pendingToolCalls[sessionKey][callID] = existing
	return nil
}

func (m *Manager) ClearPendingExchangeAux(_ context.Context, sessionKey string) {
	sessionKey = strings.TrimSpace(sessionKey)
	if sessionKey == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.pendingToolCalls, sessionKey)
}

func (m *Manager) List(_ context.Context, opts ListOptions) ([]*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listSessionsUnsafe(opts)
}

func (m *Manager) ListMetas(_ context.Context) ([]*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listSessionMetasUnsafe()
}

func (m *Manager) Search(_ context.Context, opts SearchOptions) ([]SearchHit, error) {
	query := strings.TrimSpace(opts.Query)
	if query == "" || utf8.RuneCountInString(query) < 2 {
		return []SearchHit{}, nil
	}
	limit := normalizeSearchLimit(opts.Limit)
	qLower := strings.ToLower(query)

	m.mu.Lock()
	sessions, err := m.listSessionMetasUnsafe()
	m.mu.Unlock()
	if err != nil {
		return nil, err
	}

	nameHits := make([]SearchHit, 0, limit)
	hitsByKey := make(map[string]SearchHit, limit)
	for _, item := range sessions {
		score := scoreSessionName(item.Name, qLower)
		if score <= 0 {
			continue
		}
		hit := buildSearchHit(item, "name", score, 0, item.Name)
		nameHits = append(nameHits, hit)
		hitsByKey[item.Key] = hit
	}
	sortSearchHits(nameHits)
	if len(nameHits) >= limit {
		return append([]SearchHit(nil), nameHits[:limit]...), nil
	}

	for _, item := range sessions {
		if len(hitsByKey) >= limit {
			break
		}
		if _, exists := hitsByKey[item.Key]; exists {
			continue
		}
		hit, ok, err := m.searchSessionContent(item, qLower)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		hitsByKey[item.Key] = hit
	}

	results := make([]SearchHit, 0, len(hitsByKey))
	for _, hit := range hitsByKey {
		results = append(results, hit)
	}
	sortSearchHits(results)
	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

type exchangeModelDisplayNameContextKey struct{}

func WithExchangeModelDisplayName(ctx context.Context, displayName string) context.Context {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		return ctx
	}
	return context.WithValue(ctx, exchangeModelDisplayNameContextKey{}, displayName)
}

func exchangeModelDisplayNameFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	value, _ := ctx.Value(exchangeModelDisplayNameContextKey{}).(string)
	return strings.TrimSpace(value)
}

func (m *Manager) AddExchangeForAgent(ctx context.Context, session *Session, role, content, agent, mode, effort, fastService string) error {
	return m.addExchangeForAgentAt(session, role, content, agent, exchangeModelDisplayNameFromContext(ctx), mode, effort, fastService, time.Time{})
}

func (m *Manager) AddExchangeForAgentAt(ctx context.Context, session *Session, role, content, agent, mode, effort, fastService string, timestamp time.Time) error {
	return m.addExchangeForAgentAt(session, role, content, agent, exchangeModelDisplayNameFromContext(ctx), mode, effort, fastService, timestamp)
}

func (m *Manager) addExchangeForAgentAt(session *Session, role, content, agent, modelDisplayName, mode, effort, fastService string, timestamp time.Time) error {
	if session == nil || strings.TrimSpace(session.Key) == "" {
		return errors.New("session required")
	}
	normalizedRole := strings.ToLower(strings.TrimSpace(role))
	if strings.TrimSpace(content) == "" && normalizedRole != "agent" && normalizedRole != "assistant" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	current, err := m.getSessionUnsafe(session.Key, 0)
	if err != nil {
		return err
	}
	session = current
	if session.ClosedAt != nil {
		session.ClosedAt = nil
	}
	resolvedAgent := strings.TrimSpace(agent)
	nextSeq := len(session.Exchanges) + 1
	ts := timestamp.UTC()
	if ts.IsZero() {
		ts = m.now().UTC()
	}
	record := Exchange{
		Seq:              nextSeq,
		Role:             role,
		Agent:            resolvedAgent,
		Model:            session.Model,
		ModelDisplayName: strings.TrimSpace(modelDisplayName),
		Mode:             strings.TrimSpace(mode),
		Effort:           strings.TrimSpace(effort),
		FastService:      fastService,
		Content:          content,
		Timestamp:        ts,
	}
	if err := m.appendExchange(session.Key, record); err != nil {
		log.Printf("[session/store] append.error session=%s seq=%d role=%s agent=%s err=%v", session.Key, record.Seq, role, resolvedAgent, err)
		return err
	}
	session.Exchanges = append(session.Exchanges, record)
	session.UpdatedAt = record.Timestamp
	if resolvedAgent != "" {
		if session.AgentCtxSeq == nil {
			session.AgentCtxSeq = map[string]int{}
		}
		if _, ok := session.AgentCtxSeq[resolvedAgent]; !ok {
			session.AgentCtxSeq[resolvedAgent] = 0
		}
	}
	if err := m.upsertSessionMetaUnsafe(session); err != nil {
		return err
	}
	return nil
}

func (m *Manager) AddExchangeAux(_ context.Context, sessionKey string, aux ExchangeAux) error {
	if strings.TrimSpace(sessionKey) == "" {
		return errors.New("session key required")
	}
	if aux.Seq <= 0 {
		return errors.New("aux seq required")
	}
	if aux.ToolCall == nil && strings.TrimSpace(aux.Thought) == "" && aux.Plan == nil && aux.Compact == nil {
		return errors.New("aux content required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.appendExchangeAux(sessionKey, aux)
}

func (m *Manager) AddRelatedFile(_ context.Context, key string, file RelatedFile) error {
	if strings.TrimSpace(file.Path) == "" {
		return errors.New("file path required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	session, err := m.getSessionUnsafe(key, 0)
	if err != nil {
		return err
	}
	for _, existing := range session.RelatedFiles {
		if existing.Path == file.Path {
			return nil
		}
	}
	session.RelatedFiles = append(session.RelatedFiles, file)
	if err := m.upsertSessionMetaUnsafe(session); err != nil {
		return err
	}
	return nil
}

func (m *Manager) RemoveRelatedFile(_ context.Context, key, path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return errors.New("file path required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	session, err := m.getSessionUnsafe(key, 0)
	if err != nil {
		return err
	}
	next := make([]RelatedFile, 0, len(session.RelatedFiles))
	removed := false
	for _, item := range session.RelatedFiles {
		if strings.TrimSpace(item.Path) == path {
			removed = true
			continue
		}
		next = append(next, item)
	}
	if !removed {
		return nil
	}
	session.RelatedFiles = next
	return m.upsertSessionMetaUnsafe(session)
}

func (m *Manager) RecordOutputFile(ctx context.Context, key, path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("file path required")
	}
	return m.AddRelatedFile(ctx, key, RelatedFile{
		Path:             path,
		Relation:         "output",
		CreatedBySession: true,
	})
}

func (m *Manager) UpdateAgentState(_ context.Context, session *Session, agent string, lastCtxSeq int, agentSessionID string) error {
	if session == nil || strings.TrimSpace(session.Key) == "" {
		return errors.New("session required")
	}
	if strings.TrimSpace(agent) == "" {
		return errors.New("agent required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	current, err := m.getSessionUnsafe(session.Key, 0)
	if err != nil {
		return err
	}
	session = current
	if session.AgentCtxSeq == nil {
		session.AgentCtxSeq = map[string]int{}
	}
	if lastCtxSeq >= 0 {
		session.AgentCtxSeq[agent] = lastCtxSeq
	}
	if strings.TrimSpace(agentSessionID) == "" {
		return nil
	}
	return m.upsertAgentBindingUnsafe(AgentBinding{
		SessionKey:     strings.TrimSpace(session.Key),
		Agent:          strings.TrimSpace(agent),
		AgentSessionID: strings.TrimSpace(agentSessionID),
		AgentCtxSeq:    lastCtxSeq,
	})
}

func (m *Manager) UpsertAgentBinding(_ context.Context, binding AgentBinding) error {
	if strings.TrimSpace(binding.SessionKey) == "" {
		return errors.New("session key required")
	}
	if strings.TrimSpace(binding.Agent) == "" {
		return errors.New("agent required")
	}
	if strings.TrimSpace(binding.AgentSessionID) == "" {
		return errors.New("agent session id required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.upsertAgentBindingUnsafe(binding)
}

func (m *Manager) GetAgentBinding(_ context.Context, sessionKey, agent string) (*AgentBinding, error) {
	if strings.TrimSpace(sessionKey) == "" {
		return nil, errors.New("session key required")
	}
	if strings.TrimSpace(agent) == "" {
		return nil, errors.New("agent required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	db, err := m.ensureSessionMetaDBUnsafe()
	if err != nil {
		return nil, err
	}
	row := db.QueryRow(selectAgentBindingSQL, strings.TrimSpace(sessionKey), strings.TrimSpace(agent))
	var binding AgentBinding
	if err := row.Scan(&binding.SessionKey, &binding.Agent, &binding.AgentSessionID, &binding.AgentCtxSeq); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errSessionNotFound
		}
		return nil, err
	}
	return &binding, nil
}

func (m *Manager) FindAgentBinding(ctx context.Context, sessionKey, agent string) (*AgentBinding, error) {
	binding, err := m.GetAgentBinding(ctx, sessionKey, agent)
	if errors.Is(err, errSessionNotFound) {
		return nil, nil
	}
	return binding, err
}

func (m *Manager) FindAgentBindingByAgentSession(_ context.Context, agent, agentSessionID string) (*AgentBinding, error) {
	if strings.TrimSpace(agent) == "" {
		return nil, errors.New("agent required")
	}
	if strings.TrimSpace(agentSessionID) == "" {
		return nil, errors.New("agent session id required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	db, err := m.ensureSessionMetaDBUnsafe()
	if err != nil {
		return nil, err
	}
	var binding AgentBinding
	err = db.QueryRow(
		selectBindingByAgentSessionSQL,
		strings.TrimSpace(agent),
		strings.TrimSpace(agentSessionID),
	).Scan(&binding.SessionKey, &binding.Agent, &binding.AgentSessionID, &binding.AgentCtxSeq)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &binding, nil
}

func (m *Manager) HasAgentBinding(ctx context.Context, agent, agentSessionID string) (bool, error) {
	binding, err := m.FindAgentBindingByAgentSession(ctx, agent, agentSessionID)
	if err != nil {
		return false, err
	}
	return binding != nil, nil
}

func (m *Manager) listAgentBindingsUnsafe(sessionKey string) ([]AgentBinding, error) {
	db, err := m.ensureSessionMetaDBUnsafe()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(selectAgentBindingsBySessionSQL, strings.TrimSpace(sessionKey))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	bindings := make([]AgentBinding, 0)
	for rows.Next() {
		var binding AgentBinding
		if err := rows.Scan(&binding.SessionKey, &binding.Agent, &binding.AgentSessionID, &binding.AgentCtxSeq); err != nil {
			return nil, err
		}
		bindings = append(bindings, binding)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return bindings, nil
}

func (m *Manager) upsertAgentBindingUnsafe(binding AgentBinding) error {
	db, err := m.ensureSessionMetaDBUnsafe()
	if err != nil {
		return err
	}
	agentCtxSeq := 0
	if binding.AgentCtxSeq > 0 {
		agentCtxSeq = binding.AgentCtxSeq
	}
	_, err = db.Exec(
		upsertAgentBindingSQL,
		strings.TrimSpace(binding.SessionKey),
		strings.TrimSpace(binding.Agent),
		strings.TrimSpace(binding.AgentSessionID),
		agentCtxSeq,
	)
	return err
}

func (m *Manager) Close(ctx context.Context, key string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.closeSessionUnsafe(key)
}

func (m *Manager) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.deleteSessionUnsafe(key)
}

func (m *Manager) Rename(_ context.Context, key, name string) (*Session, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return nil, errors.New("session name required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	session, err := m.getSessionUnsafe(key, 0)
	if err != nil {
		return nil, err
	}
	if session.Name == trimmed {
		return session, nil
	}
	session.Name = trimmed
	session.UpdatedAt = m.now().UTC()
	if err := m.upsertSessionMetaUnsafe(session); err != nil {
		return nil, err
	}
	return session, nil
}

func (m *Manager) UpdateModel(_ context.Context, session *Session, model string) error {
	if session == nil || strings.TrimSpace(session.Key) == "" {
		return errors.New("session required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	current, err := m.getSessionUnsafe(session.Key, 0)
	if err != nil {
		return err
	}
	model = strings.TrimSpace(model)
	if current.Model == model {
		return nil
	}
	current.Model = model
	current.UpdatedAt = m.now().UTC()
	return m.upsertSessionMetaUnsafe(current)
}

func (m *Manager) UpdateShell(_ context.Context, session *Session, shell string) error {
	if session == nil || strings.TrimSpace(session.Key) == "" {
		return errors.New("session required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	current, err := m.getSessionUnsafe(session.Key, 0)
	if err != nil {
		return err
	}
	shell = strings.TrimSpace(shell)
	if current.Shell == shell {
		return nil
	}
	current.Shell = shell
	current.UpdatedAt = m.now().UTC()
	session.Shell = shell
	session.UpdatedAt = current.UpdatedAt
	return m.upsertSessionMetaUnsafe(current)
}

func (m *Manager) UpdatePlanMode(_ context.Context, session *Session, enabled bool) error {
	if session == nil || strings.TrimSpace(session.Key) == "" {
		return errors.New("session required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	current, err := m.getSessionUnsafe(session.Key, 0)
	if err != nil {
		return err
	}
	if current.PlanMode == enabled {
		session.PlanMode = enabled
		return nil
	}
	current.PlanMode = enabled
	current.UpdatedAt = m.now().UTC()
	session.PlanMode = enabled
	session.UpdatedAt = current.UpdatedAt
	return m.upsertSessionMetaUnsafe(current)
}

func (m *Manager) closeSessionUnsafe(key string) (*Session, error) {
	session, err := m.getSessionUnsafe(key, 0)
	if err != nil {
		return nil, err
	}
	if session.ClosedAt != nil {
		return session, nil
	}
	now := m.now().UTC()
	session.ClosedAt = &now
	if err := m.upsertSessionMetaUnsafe(session); err != nil {
		return nil, err
	}
	return session, nil
}

func (m *Manager) deleteSessionUnsafe(key string) error {
	if strings.TrimSpace(key) == "" {
		return errors.New("session key required")
	}
	db, err := m.ensureSessionMetaDBUnsafe()
	if err != nil {
		return err
	}
	result, err := db.Exec(deleteSessionSQL, key)
	if err != nil {
		return err
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rowsAffected == 0 {
		return errSessionNotFound
	}
	if _, err := db.Exec(deleteBindingsBySessionSQL, key); err != nil {
		return err
	}
	delete(m.sessions, key)
	path, err := m.exchangePath(key)
	if err != nil {
		return err
	}
	metaDir, err := m.root.EnsureMetaDir()
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(metaDir, filepath.FromSlash(path))); err != nil && !os.IsNotExist(err) {
		return err
	}
	auxPath, err := m.auxPath(key)
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(metaDir, filepath.FromSlash(auxPath))); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (m *Manager) CheckIdle(ctx context.Context, idleAfter, closeAfter time.Duration) ([]*Session, []*Session, error) {
	if idleAfter <= 0 || closeAfter <= 0 {
		return nil, nil, errors.New("idle and close thresholds required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	sessions, err := m.listSessionsUnsafe(ListOptions{})
	if err != nil {
		return nil, nil, err
	}
	now := m.now().UTC()
	closed := []*Session{}
	for _, s := range sessions {
		if s.ClosedAt != nil {
			continue
		}
		if now.Sub(s.UpdatedAt) >= closeAfter {
			updated, err := m.closeSessionUnsafe(s.Key)
			if err == nil {
				closed = append(closed, updated)
			}
		}
	}
	return []*Session{}, closed, nil
}

func (m *Manager) StartIdleLoop(ctx context.Context) {
	if ctx == nil {
		return
	}
	m.loopOnce.Do(func() {
		ticker := time.NewTicker(m.idleInterval)
		go func() {
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					m.CheckIdle(ctx, m.idleFor, m.closeFor)
				case <-ctx.Done():
					return
				}
			}
		}()
	})
}

func (m *Manager) Shutdown() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.db == nil {
		return nil
	}
	db := m.db
	m.db = nil
	return db.Close()
}

func (m *Manager) MetaDir() string {
	return m.root.MetaDir()
}

func (m *Manager) Root() fs.RootInfo {
	return m.root
}

func (m *Manager) ExchangeLogPath(key string) string {
	path, err := m.exchangePath(key)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(filepath.Join(".mindfs", path))
}

func (m *Manager) createSessionUnsafe(session *Session) error {
	if session == nil {
		return errors.New("session required")
	}
	if _, ok := m.sessions[session.Key]; ok {
		return fmt.Errorf("session already exists: %s", session.Key)
	}
	if _, err := m.getSessionMetaUnsafe(session.Key); err == nil {
		return fmt.Errorf("session already exists: %s", session.Key)
	} else if !errors.Is(err, errSessionNotFound) {
		return err
	}
	if err := m.upsertSessionMetaUnsafe(session); err != nil {
		return err
	}
	path, err := m.exchangePath(session.Key)
	if err != nil {
		return err
	}
	_, statErr := m.root.ReadMetaFile(path)
	if statErr == nil {
		return nil
	}
	if !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}
	return m.root.WriteMetaFile(path, []byte{})
}

func (m *Manager) getSessionUnsafe(key string, afterSeq int) (*Session, error) {
	if afterSeq <= 0 {
		if cached, ok := m.sessions[key]; ok && cached != nil {
			return cached, nil
		}
	}
	loaded, err := m.loadSessionUnsafe(key, afterSeq)
	if err != nil {
		return nil, err
	}
	if afterSeq <= 0 {
		m.sessions[key] = loaded
	}
	return loaded, nil
}

func (m *Manager) getSessionMetaUnsafe(key string) (*Session, error) {
	if strings.TrimSpace(key) == "" {
		return nil, errors.New("session key required")
	}
	db, err := m.ensureSessionMetaDBUnsafe()
	if err != nil {
		return nil, err
	}
	row := db.QueryRow(selectSessionSQL+`
WHERE key = ?`, key)
	session, err := scanSessionMetaRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errSessionNotFound
	}
	if err != nil {
		return nil, err
	}
	return session, nil
}

func (m *Manager) listSessionMetasUnsafe() ([]*Session, error) {
	db, err := m.ensureSessionMetaDBUnsafe()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(selectSessionSQL + `
ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	items := make([]*Session, 0)
	for rows.Next() {
		item, err := scanSessionMetaRow(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, item := range items {
		bindings, err := m.listAgentBindingsUnsafe(item.Key)
		if err != nil {
			return nil, err
		}
		for _, binding := range bindings {
			if strings.TrimSpace(binding.Agent) == "" {
				continue
			}
			item.AgentCtxSeq[binding.Agent] = binding.AgentCtxSeq
		}
	}
	return items, nil
}

func (m *Manager) listSessionsUnsafe(opts ListOptions) ([]*Session, error) {
	db, err := m.ensureSessionMetaDBUnsafe()
	if err != nil {
		return nil, err
	}
	query := `
SELECT key FROM sessions`
	args := make([]any, 0, 2)
	if !opts.BeforeTime.IsZero() {
		query += `
WHERE updated_at < ?`
		args = append(args, opts.BeforeTime.UTC().Format(time.RFC3339Nano))
	} else if !opts.AfterTime.IsZero() {
		query += `
WHERE updated_at > ?`
		args = append(args, opts.AfterTime.UTC().Format(time.RFC3339Nano))
	}
	query += `
ORDER BY updated_at DESC`
	if opts.Limit > 0 {
		query += `
LIMIT ?`
		args = append(args, opts.Limit)
	}
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0)
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	items := make([]*Session, 0, len(keys))
	for _, key := range keys {
		session, err := m.getSessionUnsafe(key, 0)
		if err != nil {
			return nil, err
		}
		items = append(items, session)
	}
	return items, nil
}

func (m *Manager) loadSessionUnsafe(key string, afterSeq int) (*Session, error) {
	meta, err := m.getSessionMetaUnsafe(key)
	if err != nil {
		return nil, err
	}
	bindings, err := m.listAgentBindingsUnsafe(key)
	if err != nil {
		return nil, err
	}
	if meta.AgentCtxSeq == nil {
		meta.AgentCtxSeq = map[string]int{}
	}
	for _, binding := range bindings {
		if strings.TrimSpace(binding.Agent) == "" {
			continue
		}
		meta.AgentCtxSeq[binding.Agent] = binding.AgentCtxSeq
	}
	exchanges, _, err := m.loadExchanges(key, afterSeq)
	if err != nil {
		return nil, err
	}
	meta.Exchanges = exchanges
	return meta, nil
}

func (m *Manager) upsertSessionMetaUnsafe(session *Session) error {
	db, err := m.ensureSessionMetaDBUnsafe()
	if err != nil {
		return err
	}
	if session == nil {
		return errors.New("session required")
	}
	normalizeSessionMeta(session)
	args, err := sessionMetaUpsertArgs(session)
	if err != nil {
		return err
	}
	_, err = db.Exec(upsertSessionMetaSQL, args...)
	if err != nil {
		return err
	}
	return nil
}

func (m *Manager) loadExchanges(key string, afterSeq int) ([]Exchange, int, error) {
	path, err := m.exchangePath(key)
	if err != nil {
		return nil, 0, err
	}
	payload, err := m.root.ReadMetaFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []Exchange{}, 0, nil
		}
		return nil, 0, err
	}
	exchanges := make([]Exchange, 0)
	total := 0
	scanner := jsonlScanner(payload)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry Exchange
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Seq <= 0 {
			entry.Seq = total + 1
		}
		if entry.Seq > total {
			total = entry.Seq
		}
		if afterSeq > 0 && entry.Seq <= afterSeq {
			continue
		}
		exchanges = append(exchanges, entry)
	}
	if err := scanner.Err(); err != nil {
		return nil, 0, err
	}
	return exchanges, total, nil
}

func (m *Manager) appendExchange(key string, exchange Exchange) error {
	path, err := m.exchangePath(key)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(exchange)
	if err != nil {
		return err
	}
	file, err := m.root.OpenMetaFileAppend(path)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err := file.Write(append(payload, '\n')); err != nil {
		return err
	}
	return nil
}

func (m *Manager) loadExchangeAux(key string, afterSeq int) (map[int][]ExchangeAux, error) {
	entries, err := m.loadExchangeAuxEntries(key, afterSeq)
	if err != nil {
		return nil, err
	}
	items := make(map[int][]ExchangeAux)
	for _, entry := range entries {
		compacted, ok := CompactExchangeAux(entry)
		if !ok {
			continue
		}
		items[compacted.Seq] = append(items[compacted.Seq], compacted)
	}
	return items, nil
}

func (m *Manager) loadExchangeAuxEntries(key string, afterSeq int) ([]ExchangeAux, error) {
	path, err := m.auxPath(key)
	if err != nil {
		return nil, err
	}
	payload, err := m.root.ReadMetaFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []ExchangeAux{}, nil
		}
		return nil, err
	}
	items := make([]ExchangeAux, 0)
	scanner := jsonlScanner(payload)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry ExchangeAux
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Seq <= 0 {
			continue
		}
		if afterSeq > 0 && entry.Seq <= afterSeq {
			continue
		}
		items = append(items, entry)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func mergeToolCall(base, next agenttypes.ToolCall) agenttypes.ToolCall {
	merged := base
	if strings.TrimSpace(next.CallID) != "" {
		merged.CallID = next.CallID
	}
	if strings.TrimSpace(next.Title) != "" {
		merged.Title = next.Title
	}
	if strings.TrimSpace(next.Status) != "" {
		merged.Status = next.Status
	}
	if next.Kind != "" {
		merged.Kind = next.Kind
	}
	if len(next.Content) > 0 {
		merged.Content = append([]agenttypes.ToolCallContentItem(nil), next.Content...)
	}
	if len(next.Locations) > 0 {
		merged.Locations = append([]agenttypes.ToolCallLocation(nil), next.Locations...)
	}
	if strings.TrimSpace(next.RawType) != "" {
		merged.RawType = next.RawType
	}
	if len(base.Meta) > 0 || len(next.Meta) > 0 {
		merged.Meta = make(map[string]any, len(base.Meta)+len(next.Meta))
		for key, value := range base.Meta {
			merged.Meta[key] = value
		}
		for key, value := range next.Meta {
			merged.Meta[key] = value
		}
	}
	return merged
}

func (m *Manager) pendingFullToolCallUnsafe(sessionKey, callID string) (*agenttypes.ToolCall, bool) {
	if m.pendingToolCalls == nil {
		return nil, false
	}
	toolCall, ok := m.pendingToolCalls[sessionKey][callID]
	if !ok {
		return nil, false
	}
	out := cloneToolCall(toolCall)
	return &out, true
}

func cloneToolCall(toolCall agenttypes.ToolCall) agenttypes.ToolCall {
	out := toolCall
	out.Content = append([]agenttypes.ToolCallContentItem(nil), toolCall.Content...)
	out.Locations = append([]agenttypes.ToolCallLocation(nil), toolCall.Locations...)
	if len(toolCall.Meta) > 0 {
		out.Meta = make(map[string]any, len(toolCall.Meta))
		for key, value := range toolCall.Meta {
			out.Meta[key] = value
		}
	}
	return out
}

func jsonlScanner(payload []byte) *bufio.Scanner {
	scanner := bufio.NewScanner(strings.NewReader(string(payload)))
	maxTokenSize := len(payload) + 1
	if maxTokenSize < 64*1024 {
		maxTokenSize = 64 * 1024
	}
	scanner.Buffer(make([]byte, 0, 64*1024), maxTokenSize)
	return scanner
}

func (m *Manager) appendExchangeAux(key string, aux ExchangeAux) error {
	path, err := m.auxPath(key)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(aux)
	if err != nil {
		return err
	}
	file, err := m.root.OpenMetaFileAppend(path)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err := file.Write(append(payload, '\n')); err != nil {
		return err
	}
	return nil
}

func (m *Manager) exchangePath(key string) (string, error) {
	if strings.TrimSpace(m.root.MetaDir()) == "" {
		return "", errors.New("managed dir required")
	}
	if key == "" {
		return "", errors.New("session key required")
	}
	if strings.Contains(key, "..") || strings.ContainsRune(key, filepath.Separator) || strings.Contains(key, "/") {
		return "", fmt.Errorf("invalid session key: %s", key)
	}
	return filepath.ToSlash(fmt.Sprintf(exchangeFileTpl, key)), nil
}

func (m *Manager) auxPath(key string) (string, error) {
	if strings.TrimSpace(m.root.MetaDir()) == "" {
		return "", errors.New("managed dir required")
	}
	if key == "" {
		return "", errors.New("session key required")
	}
	if strings.Contains(key, "..") || strings.ContainsRune(key, filepath.Separator) || strings.Contains(key, "/") {
		return "", fmt.Errorf("invalid session key: %s", key)
	}
	return filepath.ToSlash(fmt.Sprintf(auxFileTpl, key)), nil
}

func (m *Manager) ensureSessionMetaDBUnsafe() (*sql.DB, error) {
	if m.db != nil {
		return m.db, nil
	}
	metaDir, err := m.root.EnsureMetaDir()
	if err != nil {
		return nil, err
	}
	legacyDBFile := filepath.Join(metaDir, filepath.FromSlash(sessionDBPath))
	linkFile := legacyDBFile + sessionDBLinkExt
	if linkedDBFile, ok, err := readSessionDBLink(linkFile); err != nil {
		return nil, err
	} else if ok {
		db, err := openSessionMetaDB(linkedDBFile)
		if err != nil {
			return nil, err
		}
		m.db = db
		return m.db, nil
	}

	db, err := openSessionMetaDB(legacyDBFile)
	if err == nil {
		m.db = db
		return m.db, nil
	}
	legacyErr := err

	fallbackDBFile, err := userDataSessionDBFile(m.root.ID)
	if err != nil {
		return nil, fmt.Errorf("open legacy session db: %w; resolve fallback session db: %w", legacyErr, err)
	}
	db, err = openSessionMetaDB(fallbackDBFile)
	if err != nil {
		return nil, fmt.Errorf("open legacy session db: %w; open fallback session db: %w", legacyErr, err)
	}
	if err := writeSessionDBLink(linkFile, fallbackDBFile); err != nil {
		db.Close()
		return nil, fmt.Errorf("open legacy session db: %w; write session db link: %w", legacyErr, err)
	}
	log.Printf("[session/store] sqlite fallback root=%s legacy=%s fallback=%s err=%v", m.root.ID, legacyDBFile, fallbackDBFile, legacyErr)
	m.db = db
	return m.db, nil
}

func openSessionMetaDB(dbFile string) (db *sql.DB, err error) {
	defer func() {
		if r := recover(); r != nil {
			if db != nil {
				db.Close()
			}
			err = fmt.Errorf("sqlite init panic for %s: %v", dbFile, r)
		}
	}()
	if err := os.MkdirAll(filepath.Dir(dbFile), 0o755); err != nil {
		return nil, err
	}
	db, err = openSQLiteDB(dbFile)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(sessionTableSchema); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(agentBindingTableSchema); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(`ALTER TABLE sessions ADD COLUMN model TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(`ALTER TABLE sessions ADD COLUMN shell TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(`ALTER TABLE sessions ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		db.Close()
		return nil, err
	}
	for _, stmt := range []string{
		`ALTER TABLE sessions ADD COLUMN parent_session_key TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE sessions ADD COLUMN parent_tool_call_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := db.Exec(stmt); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
			db.Close()
			return nil, err
		}
	}
	return db, nil
}

func readSessionDBLink(linkFile string) (string, bool, error) {
	payload, err := os.ReadFile(linkFile)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	dbFile := strings.TrimSpace(string(payload))
	if dbFile == "" {
		return "", false, fmt.Errorf("empty session db link: %s", linkFile)
	}
	if !filepath.IsAbs(dbFile) {
		return "", false, fmt.Errorf("session db link must be absolute: %s", linkFile)
	}
	return dbFile, true, nil
}

func writeSessionDBLink(linkFile, dbFile string) error {
	if strings.TrimSpace(dbFile) == "" {
		return errors.New("session db link target required")
	}
	if !filepath.IsAbs(dbFile) {
		return errors.New("session db link target must be absolute")
	}
	if err := os.MkdirAll(filepath.Dir(linkFile), 0o755); err != nil {
		return err
	}
	return os.WriteFile(linkFile, []byte(dbFile+"\n"), 0o644)
}

func userDataSessionDBFile(rootID string) (string, error) {
	configDir, err := mindFSConfigDir()
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(rootID)
	if id == "" {
		id = "default"
	}
	return filepath.Join(configDir, url.PathEscape(id), "session-list.db"), nil
}

func sessionMetaUpsertArgs(session *Session) ([]any, error) {
	if session == nil {
		return nil, errors.New("session required")
	}
	relatedFilesJSON, err := json.Marshal(session.RelatedFiles)
	if err != nil {
		return nil, err
	}
	var closedAt any
	if session.ClosedAt != nil {
		closedAt = session.ClosedAt.UTC().Format(time.RFC3339Nano)
	}
	return []any{
		session.Key,
		session.Type,
		session.ParentSessionKey,
		session.ParentToolCallID,
		session.Source,
		session.Model,
		session.Shell,
		boolToSQLiteInt(session.PlanMode),
		session.Name,
		string(relatedFilesJSON),
		session.CreatedAt.UTC().Format(time.RFC3339Nano),
		session.UpdatedAt.UTC().Format(time.RFC3339Nano),
		closedAt,
	}, nil
}

func boolToSQLiteInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanSessionMetaRow(scanner rowScanner) (*Session, error) {
	var (
		key              string
		typ              string
		parentSessionKey string
		parentToolCallID string
		source           string
		model            string
		shell            string
		planMode         int
		name             string
		relatedFilesJSON string
		createdAtRaw     string
		updatedAtRaw     string
		closedAtRaw      sql.NullString
	)
	if err := scanner.Scan(
		&key,
		&typ,
		&parentSessionKey,
		&parentToolCallID,
		&source,
		&model,
		&shell,
		&planMode,
		&name,
		&relatedFilesJSON,
		&createdAtRaw,
		&updatedAtRaw,
		&closedAtRaw,
	); err != nil {
		return nil, err
	}
	session := &Session{
		Key:              key,
		Type:             typ,
		ParentSessionKey: parentSessionKey,
		ParentToolCallID: parentToolCallID,
		Source:           source,
		Model:            model,
		Shell:            shell,
		PlanMode:         planMode != 0,
		Name:             name,
		Exchanges:        []Exchange{},
		RelatedFiles:     []RelatedFile{},
	}
	if strings.TrimSpace(relatedFilesJSON) != "" {
		if err := json.Unmarshal([]byte(relatedFilesJSON), &session.RelatedFiles); err != nil {
			session.RelatedFiles = []RelatedFile{}
		}
	}
	createdAt, err := time.Parse(time.RFC3339Nano, createdAtRaw)
	if err != nil {
		createdAt = time.Time{}
	}
	updatedAt, err := time.Parse(time.RFC3339Nano, updatedAtRaw)
	if err != nil {
		updatedAt = createdAt
	}
	session.CreatedAt = createdAt
	session.UpdatedAt = updatedAt
	if closedAtRaw.Valid && strings.TrimSpace(closedAtRaw.String) != "" {
		closedAt, err := time.Parse(time.RFC3339Nano, closedAtRaw.String)
		if err == nil {
			session.ClosedAt = &closedAt
		}
	}
	normalizeSessionMeta(session)
	return session, nil
}

func normalizeSessionMeta(s *Session) {
	if s.AgentCtxSeq == nil {
		s.AgentCtxSeq = map[string]int{}
	}
	if s.RelatedFiles == nil {
		s.RelatedFiles = []RelatedFile{}
	}
	if s.Exchanges == nil {
		s.Exchanges = []Exchange{}
	}
	s.ParentSessionKey = strings.TrimSpace(s.ParentSessionKey)
	s.ParentToolCallID = strings.TrimSpace(s.ParentToolCallID)
	s.Source = strings.TrimSpace(s.Source)
}

var errSessionNotFound = errors.New("session not found")

func normalizeSearchLimit(limit int) int {
	switch {
	case limit <= 0:
		return 20
	case limit > 50:
		return 50
	default:
		return limit
	}
}

func scoreSessionName(name, qLower string) int {
	name = strings.TrimSpace(name)
	if name == "" || qLower == "" {
		return 0
	}
	nameLower := strings.ToLower(name)
	switch {
	case nameLower == qLower:
		return 120
	case strings.HasPrefix(nameLower, qLower):
		return 100
	case strings.Contains(nameLower, qLower):
		return 80
	default:
		return 0
	}
}

func buildSearchHit(s *Session, matchType string, score, seq int, snippet string) SearchHit {
	return SearchHit{
		Key:              s.Key,
		Type:             s.Type,
		ParentSessionKey: s.ParentSessionKey,
		ParentToolCallID: s.ParentToolCallID,
		Agent:            InferAgentFromSession(s),
		Model:            s.Model,
		Shell:            s.Shell,
		Name:             s.Name,
		CreatedAt:        s.CreatedAt,
		UpdatedAt:        s.UpdatedAt,
		ClosedAt:         s.ClosedAt,
		MatchType:        matchType,
		MatchScore:       score,
		Seq:              seq,
		Snippet:          strings.TrimSpace(snippet),
	}
}

func sortSearchHits(items []SearchHit) {
	sort.SliceStable(items, func(i, j int) bool {
		left := items[i]
		right := items[j]
		if left.MatchType != right.MatchType {
			return searchMatchTypeRank(left.MatchType) < searchMatchTypeRank(right.MatchType)
		}
		if left.MatchScore != right.MatchScore {
			return left.MatchScore > right.MatchScore
		}
		if !left.UpdatedAt.Equal(right.UpdatedAt) {
			return left.UpdatedAt.After(right.UpdatedAt)
		}
		return left.Key < right.Key
	})
}

func searchMatchTypeRank(matchType string) int {
	switch strings.TrimSpace(matchType) {
	case "name":
		return 0
	case "user":
		return 1
	case "reply":
		return 2
	default:
		return 3
	}
}

func (m *Manager) searchSessionContent(s *Session, qLower string) (SearchHit, bool, error) {
	path, err := m.exchangePath(s.Key)
	if err != nil {
		return SearchHit{}, false, err
	}
	file, err := m.root.OpenMetaFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return SearchHit{}, false, nil
		}
		return SearchHit{}, false, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	best := SearchHit{}
	bestFound := false
	bestRoleUser := false
	bestPos := 0
	bestSeq := 0

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if !strings.Contains(strings.ToLower(line), qLower) {
			continue
		}
		var entry Exchange
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		content := strings.TrimSpace(entry.Content)
		if content == "" {
			continue
		}
		lowerContent := strings.ToLower(content)
		pos := strings.Index(lowerContent, qLower)
		if pos < 0 {
			continue
		}
		roleUser := strings.EqualFold(strings.TrimSpace(entry.Role), "user")
		matchRunes := utf8.RuneCountInString(lowerContent[:pos])
		queryRunes := utf8.RuneCountInString(qLower)
		matchType := "reply"
		matchScore := 60
		if roleUser {
			matchType = "user"
			matchScore = 65
		}
		hit := buildSearchHit(s, matchType, matchScore, entry.Seq, buildSearchSnippet(content, matchRunes, queryRunes))
		if !bestFound || roleUser && !bestRoleUser || roleUser == bestRoleUser && (pos < bestPos || pos == bestPos && entry.Seq < bestSeq) {
			best = hit
			bestFound = true
			bestRoleUser = roleUser
			bestPos = pos
			bestSeq = entry.Seq
		}
	}
	if err := scanner.Err(); err != nil {
		return SearchHit{}, false, err
	}
	if !bestFound {
		return SearchHit{}, false, nil
	}
	return best, true, nil
}

func buildSearchSnippet(content string, matchRunes, queryRunes int) string {
	content = strings.TrimSpace(content)
	if content == "" {
		return ""
	}
	runes := []rune(content)
	start := 0
	end := len(runes)
	if matchRunes >= 0 {
		const contextBefore = 10
		const contextAfter = 18
		start = matchRunes - contextBefore
		if start < 0 {
			start = 0
		}
		end = matchRunes + queryRunes + contextAfter
		if end > len(runes) {
			end = len(runes)
		}
	}
	snippet := strings.TrimSpace(string(runes[start:end]))
	if start > 0 {
		snippet = "..." + snippet
	}
	if end < len(runes) {
		snippet += "..."
	}
	return snippet
}

func generateKey() string {
	now := time.Now().UTC().Unix()
	buf := make([]byte, 6)
	_, err := rand.Read(buf)
	if err != nil {
		return fmt.Sprintf("%d", now)
	}
	return fmt.Sprintf("%d-%s", now, hex.EncodeToString(buf))
}
