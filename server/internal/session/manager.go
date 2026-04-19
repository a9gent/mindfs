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
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/fs"

	_ "modernc.org/sqlite"
)

const (
	sessionDBPath    = "sessions/session-list.db"
	exchangeFileTpl  = "sessions/%s.jsonl"
	selectSessionSQL = `
SELECT key, type, model, name, related_files_json, created_at, updated_at, closed_at
FROM sessions`
	deleteSessionSQL = `
DELETE FROM sessions
WHERE key = ?`
	deleteBindingsBySessionSQL = `
DELETE FROM session_agent_bindings
WHERE session_key = ?`
	upsertSessionMetaSQL = `
INSERT INTO sessions (
	key, type, model, name, related_files_json, created_at, updated_at, closed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
	type = excluded.type,
	model = excluded.model,
	name = excluded.name,
	related_files_json = excluded.related_files_json,
	created_at = excluded.created_at,
	updated_at = excluded.updated_at,
	closed_at = excluded.closed_at`
	sessionTableSchema = `
CREATE TABLE IF NOT EXISTS sessions (
	key TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	model TEXT NOT NULL DEFAULT '',
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
SELECT 1
FROM session_agent_bindings
WHERE agent = ? AND agent_session_id = ?
LIMIT 1`
)

type Manager struct {
	root            fs.RootInfo
	mu              sync.Mutex
	loopOnce        sync.Once
	db              *sql.DB
	sessions        map[string]*Session
	now             func() time.Time
	idleInterval    time.Duration
	idleFor         time.Duration
	closeFor        time.Duration
	maxIdleSessions int
}

type CreateInput struct {
	Key   string
	Type  string
	Agent string
	Model string
	Name  string
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
		root:            root,
		sessions:        make(map[string]*Session),
		now:             time.Now,
		idleInterval:    1 * time.Minute,
		idleFor:         10 * time.Minute,
		closeFor:        7 * 24 * time.Hour,
		maxIdleSessions: 3,
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
		Key:          key,
		Type:         input.Type,
		AgentCtxSeq:  agentCtxSeq,
		Model:        strings.TrimSpace(input.Model),
		Name:         name,
		Exchanges:    []Exchange{},
		RelatedFiles: []RelatedFile{},
		CreatedAt:    now,
		UpdatedAt:    now,
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

func (m *Manager) List(_ context.Context, opts ListOptions) ([]*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listSessionsUnsafe(opts)
}

func (m *Manager) AddExchangeForAgent(_ context.Context, session *Session, role, content, agent, mode, effort string) error {
	if session == nil || strings.TrimSpace(session.Key) == "" {
		return errors.New("session required")
	}
	if strings.TrimSpace(content) == "" {
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
	record := Exchange{
		Seq:       nextSeq,
		Role:      role,
		Agent:     resolvedAgent,
		Model:     session.Model,
		Mode:      strings.TrimSpace(mode),
		Effort:    strings.TrimSpace(effort),
		Content:   content,
		Timestamp: m.now().UTC(),
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

func (m *Manager) HasAgentBinding(_ context.Context, agent, agentSessionID string) (bool, error) {
	if strings.TrimSpace(agent) == "" {
		return false, errors.New("agent required")
	}
	if strings.TrimSpace(agentSessionID) == "" {
		return false, errors.New("agent session id required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	db, err := m.ensureSessionMetaDBUnsafe()
	if err != nil {
		return false, err
	}
	var found int
	err = db.QueryRow(
		selectBindingByAgentSessionSQL,
		strings.TrimSpace(agent),
		strings.TrimSpace(agentSessionID),
	).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return found == 1, nil
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
	if !os.IsNotExist(statErr) {
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
		if os.IsNotExist(err) {
			return []Exchange{}, 0, nil
		}
		return nil, 0, err
	}
	exchanges := make([]Exchange, 0)
	total := 0
	scanner := bufio.NewScanner(strings.NewReader(string(payload)))
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

func (m *Manager) ensureSessionMetaDBUnsafe() (*sql.DB, error) {
	if m.db != nil {
		return m.db, nil
	}
	metaDir, err := m.root.EnsureMetaDir()
	if err != nil {
		return nil, err
	}
	dbFile := filepath.Join(metaDir, filepath.FromSlash(sessionDBPath))
	if err := os.MkdirAll(filepath.Dir(dbFile), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dbFile)
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
	m.db = db
	return m.db, nil
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
		session.Model,
		session.Name,
		string(relatedFilesJSON),
		session.CreatedAt.UTC().Format(time.RFC3339Nano),
		session.UpdatedAt.UTC().Format(time.RFC3339Nano),
		closedAt,
	}, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanSessionMetaRow(scanner rowScanner) (*Session, error) {
	var (
		key              string
		typ              string
		model            string
		name             string
		relatedFilesJSON string
		createdAtRaw     string
		updatedAtRaw     string
		closedAtRaw      sql.NullString
	)
	if err := scanner.Scan(
		&key,
		&typ,
		&model,
		&name,
		&relatedFilesJSON,
		&createdAtRaw,
		&updatedAtRaw,
		&closedAtRaw,
	); err != nil {
		return nil, err
	}
	session := &Session{
		Key:          key,
		Type:         typ,
		Model:        model,
		Name:         name,
		Exchanges:    []Exchange{},
		RelatedFiles: []RelatedFile{},
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
}

var errSessionNotFound = errors.New("session not found")

func generateKey() string {
	now := time.Now().UTC().Unix()
	buf := make([]byte, 6)
	_, err := rand.Read(buf)
	if err != nil {
		return fmt.Sprintf("%d", now)
	}
	return fmt.Sprintf("%d-%s", now, hex.EncodeToString(buf))
}
