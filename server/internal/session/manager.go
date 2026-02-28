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
SELECT key, type, name, related_files_json, generated_view, created_at, updated_at, closed_at
FROM sessions`
	upsertSessionMetaSQL = `
INSERT INTO sessions (
	key, type, name, related_files_json, generated_view, created_at, updated_at, closed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
	type = excluded.type,
	name = excluded.name,
	related_files_json = excluded.related_files_json,
	generated_view = excluded.generated_view,
	created_at = excluded.created_at,
	updated_at = excluded.updated_at,
	closed_at = excluded.closed_at`
	sessionTableSchema = `
CREATE TABLE IF NOT EXISTS sessions (
	key TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	name TEXT NOT NULL,
	related_files_json TEXT NOT NULL,
	generated_view TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	closed_at TEXT
);`
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
	Name  string
}

func NewManager(root fs.RootInfo, opts ...Option) *Manager {
	m := &Manager{
		root:            root,
		sessions:        make(map[string]*Session),
		now:             time.Now,
		idleInterval:    1 * time.Minute,
		idleFor:         10 * time.Minute,
		closeFor:        30 * time.Minute,
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

func (m *Manager) Get(_ context.Context, key string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.getSessionUnsafe(key)
}

func (m *Manager) List(_ context.Context) ([]*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listSessionsUnsafe()
}

func (m *Manager) AddExchangeForAgent(_ context.Context, session *Session, role, content, agent string) error {
	if session == nil || strings.TrimSpace(session.Key) == "" {
		return errors.New("session required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	current, err := m.getSessionUnsafe(session.Key)
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
		Content:   content,
		Timestamp: m.now().UTC(),
	}
	if err := m.appendExchange(session.Key, record); err != nil {
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
	session, err := m.getSessionUnsafe(key)
	if err != nil {
		return err
	}
	for _, existing := range session.RelatedFiles {
		if existing.Path == file.Path {
			return nil
		}
	}
	session.RelatedFiles = append(session.RelatedFiles, file)
	session.UpdatedAt = m.now().UTC()
	if err := m.upsertSessionMetaUnsafe(session); err != nil {
		return err
	}
	return nil
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

func (m *Manager) UpdateAgentState(_ context.Context, session *Session, agent string, lastCtxSeq int) error {
	if session == nil || strings.TrimSpace(session.Key) == "" {
		return errors.New("session required")
	}
	if strings.TrimSpace(agent) == "" {
		return errors.New("agent required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	current, err := m.getSessionUnsafe(session.Key)
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
	return nil
}

func (m *Manager) Close(ctx context.Context, key string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.closeSessionUnsafe(key)
}

func (m *Manager) closeSessionUnsafe(key string) (*Session, error) {
	session, err := m.getSessionUnsafe(key)
	if err != nil {
		return nil, err
	}
	if session.ClosedAt != nil {
		return session, nil
	}
	now := m.now().UTC()
	session.ClosedAt = &now
	session.UpdatedAt = now
	if err := m.upsertSessionMetaUnsafe(session); err != nil {
		return nil, err
	}
	return session, nil
}

func (m *Manager) CheckIdle(ctx context.Context, idleAfter, closeAfter time.Duration) ([]*Session, []*Session, error) {
	if idleAfter <= 0 || closeAfter <= 0 {
		return nil, nil, errors.New("idle and close thresholds required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	sessions, err := m.listSessionsUnsafe()
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

func (m *Manager) getSessionUnsafe(key string) (*Session, error) {
	if cached, ok := m.sessions[key]; ok && cached != nil {
		return cached, nil
	}
	loaded, err := m.loadSessionUnsafe(key)
	if err != nil {
		return nil, err
	}
	m.sessions[key] = loaded
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

func (m *Manager) listSessionsUnsafe() ([]*Session, error) {
	db, err := m.ensureSessionMetaDBUnsafe()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`
SELECT key FROM sessions
ORDER BY updated_at DESC`)
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
		session, err := m.getSessionUnsafe(key)
		if err != nil {
			return nil, err
		}
		items = append(items, session)
	}
	return items, nil
}

func (m *Manager) loadSessionUnsafe(key string) (*Session, error) {
	meta, err := m.getSessionMetaUnsafe(key)
	if err != nil {
		return nil, err
	}
	exchanges, _, err := m.loadExchanges(key)
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

func (m *Manager) loadExchanges(key string) ([]Exchange, int, error) {
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
		session.Name,
		string(relatedFilesJSON),
		session.GeneratedView,
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
		name             string
		relatedFilesJSON string
		generatedView    string
		createdAtRaw     string
		updatedAtRaw     string
		closedAtRaw      sql.NullString
	)
	if err := scanner.Scan(
		&key,
		&typ,
		&name,
		&relatedFilesJSON,
		&generatedView,
		&createdAtRaw,
		&updatedAtRaw,
		&closedAtRaw,
	); err != nil {
		return nil, err
	}
	session := &Session{
		Key:           key,
		Type:          typ,
		Name:          name,
		GeneratedView: generatedView,
		Exchanges:     []Exchange{},
		RelatedFiles:  []RelatedFile{},
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
