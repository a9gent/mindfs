package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/fs"
)

type SummaryGenerator func(context.Context, *Session) (*SessionSummary, error)

type AuditLogger interface {
	LogSession(action, actor, sessionKey, agentName string, details map[string]any) error
}

const (
	AuditActionSessionCreate  = "create"
	AuditActionSessionMessage = "message"
	AuditActionSessionClose   = "close"
	AuditActionSessionResume  = "resume"

	AuditActorUser   = "user"
	AuditActorAgent  = "agent"
	AuditActorSystem = "system"
)

type Manager struct {
	root            fs.RootInfo
	mu              sync.Mutex
	loopOnce        sync.Once
	now             func() time.Time
	summaryGenerate SummaryGenerator
	resume          Resumer
	audit           AuditLogger
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

func WithSummaryGenerator(gen SummaryGenerator) Option {
	return func(m *Manager) {
		m.summaryGenerate = gen
	}
}

func WithResumer(resumer Resumer) Option {
	return func(m *Manager) {
		m.resume = resumer
	}
}

func WithAuditLogger(logger AuditLogger) Option {
	return func(m *Manager) {
		m.audit = logger
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

func (m *Manager) Create(ctx context.Context, input CreateInput) (*Session, error) {
	if strings.TrimSpace(input.Type) == "" {
		return nil, errors.New("session type required")
	}
	if strings.TrimSpace(input.Agent) == "" {
		return nil, errors.New("agent required")
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
	session := &Session{
		Key:       key,
		Type:      input.Type,
		Agent:     input.Agent,
		Name:      name,
		Status:    StatusActive,
		CreatedAt: now,
		UpdatedAt: now,
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.createLocked(session); err != nil {
		return nil, err
	}
	m.logSession(AuditActionSessionCreate, AuditActorUser, session.Key, session.Agent, map[string]any{
		"type": session.Type,
		"name": session.Name,
	})
	return session, nil
}

func (m *Manager) Get(_ context.Context, key string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.getLocked(key)
}

func (m *Manager) List(_ context.Context) ([]*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listLocked()
}

func (m *Manager) AddExchange(_ context.Context, key, role, content string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, err := m.getLocked(key)
	if err != nil {
		return nil, err
	}
	session.Exchanges = append(session.Exchanges, Exchange{
		Role:      role,
		Content:   content,
		Timestamp: m.now().UTC(),
	})
	session.Status = StatusActive
	session.UpdatedAt = m.now().UTC()
	if err := m.saveLocked(session); err != nil {
		return nil, err
	}
	actor := AuditActorUser
	if strings.EqualFold(strings.TrimSpace(role), "agent") {
		actor = AuditActorAgent
	}
	m.logSession(AuditActionSessionMessage, actor, key, session.Agent, map[string]any{
		"content_length": len(content),
		"role":           role,
	})
	return session, nil
}

func (m *Manager) AddRelatedFile(_ context.Context, key string, file RelatedFile) (*Session, error) {
	if strings.TrimSpace(file.Path) == "" {
		return nil, errors.New("file path required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	session, err := m.getLocked(key)
	if err != nil {
		return nil, err
	}
	for _, existing := range session.RelatedFiles {
		if existing.Path == file.Path {
			return session, nil
		}
	}
	session.RelatedFiles = append(session.RelatedFiles, file)
	session.UpdatedAt = m.now().UTC()
	if err := m.saveLocked(session); err != nil {
		return nil, err
	}
	return session, nil
}

func (m *Manager) RecordOutputFile(ctx context.Context, key, path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("file path required")
	}
	_, err := m.AddRelatedFile(ctx, key, RelatedFile{
		Path:             path,
		Relation:         "output",
		CreatedBySession: true,
	})
	return err
}

func (m *Manager) UpdateAgentSessionID(_ context.Context, key string, agentSessionID string) (*Session, error) {
	if strings.TrimSpace(agentSessionID) == "" {
		return nil, errors.New("agent session id required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	session, err := m.getLocked(key)
	if err != nil {
		return nil, err
	}
	if session.AgentSessionID != nil && *session.AgentSessionID == agentSessionID {
		return session, nil
	}
	session.AgentSessionID = &agentSessionID
	session.UpdatedAt = m.now().UTC()
	if err := m.saveLocked(session); err != nil {
		return nil, err
	}
	return session, nil
}

func (m *Manager) Close(ctx context.Context, key string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.closeLocked(ctx, key)
}

func (m *Manager) closeLocked(ctx context.Context, key string) (*Session, error) {
	session, err := m.getLocked(key)
	if err != nil {
		return nil, err
	}
	if session.Status == StatusClosed {
		return session, nil
	}
	now := m.now().UTC()
	if session.Summary == nil {
		if m.summaryGenerate != nil {
			if summary, err := m.summaryGenerate(ctx, session); err == nil {
				session.Summary = summary
			}
		}
		if session.Summary == nil {
			session.Summary = &SessionSummary{
				Title:       session.Name,
				Description: "",
				KeyActions:  []string{},
				Outputs:     []string{},
				GeneratedAt: now,
			}
		}
	}
	session.Status = StatusClosed
	session.ClosedAt = &now
	session.UpdatedAt = now
	if err := m.saveLocked(session); err != nil {
		return nil, err
	}
	m.logSession(AuditActionSessionClose, AuditActorUser, key, session.Agent, nil)
	return session, nil
}

func (m *Manager) MarkIdle(_ context.Context, key string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.markIdleLocked(key)
}

func (m *Manager) markIdleLocked(key string) (*Session, error) {
	session, err := m.getLocked(key)
	if err != nil {
		return nil, err
	}
	if session.Status != StatusActive {
		return session, nil
	}
	session.Status = StatusIdle
	session.UpdatedAt = m.now().UTC()
	if err := m.saveLocked(session); err != nil {
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
	sessions, err := m.listLocked()
	if err != nil {
		return nil, nil, err
	}
	now := m.now().UTC()
	markedIdle := []*Session{}
	closed := []*Session{}
	for _, s := range sessions {
		last := s.UpdatedAt
		idleFor := now.Sub(last)
		switch s.Status {
		case StatusActive:
			if idleFor >= idleAfter {
				updated, err := m.markIdleLocked(s.Key)
				if err == nil {
					markedIdle = append(markedIdle, updated)
				}
			}
		case StatusIdle:
			if idleFor >= closeAfter {
				updated, err := m.closeLocked(ctx, s.Key)
				if err == nil {
					closed = append(closed, updated)
				}
			}
		}
	}
	return markedIdle, closed, nil
}

func (m *Manager) Resume(ctx context.Context, key string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, err := m.getLocked(key)
	if err != nil {
		return nil, err
	}
	if m.resume != nil {
		if err := m.resume.Resume(ctx, session); err != nil {
			return nil, err
		}
	}
	session.Status = StatusActive
	session.UpdatedAt = m.now().UTC()
	if err := m.saveLocked(session); err != nil {
		return nil, err
	}
	m.logSession(AuditActionSessionResume, AuditActorUser, key, session.Agent, nil)
	return session, nil
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
					_, _, _ = m.CheckIdle(ctx, m.idleFor, m.closeFor)
					m.enforceMaxIdleSessions(ctx, m.maxIdleSessions)
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

func (m *Manager) createLocked(session *Session) error {
	if session == nil {
		return errors.New("session required")
	}
	path, err := m.sessionPath(session.Key)
	if err != nil {
		return err
	}
	if _, err := m.getLocked(session.Key); err == nil {
		return fmt.Errorf("session already exists: %s", session.Key)
	} else if !errors.Is(err, errSessionNotFound) {
		return err
	}
	return m.writeJSON(path, session)
}

func (m *Manager) saveLocked(session *Session) error {
	if session == nil {
		return errors.New("session required")
	}
	path, err := m.sessionPath(session.Key)
	if err != nil {
		return err
	}
	return m.writeJSON(path, session)
}

func (m *Manager) getLocked(key string) (*Session, error) {
	path, err := m.sessionPath(key)
	if err != nil {
		return nil, err
	}
	payload, err := m.root.ReadMetaFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errSessionNotFound
		}
		return nil, err
	}
	var session Session
	if err := json.Unmarshal(payload, &session); err != nil {
		return nil, err
	}
	return &session, nil
}

func (m *Manager) listLocked() ([]*Session, error) {
	entries, err := m.root.ListMetaEntries("sessions")
	if err != nil {
		if os.IsNotExist(err) {
			return []*Session{}, nil
		}
		return nil, err
	}
	items := make([]*Session, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "session-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		payload, err := m.root.ReadMetaFile(filepath.Join("sessions", name))
		if err != nil {
			continue
		}
		var session Session
		if err := json.Unmarshal(payload, &session); err != nil {
			continue
		}
		items = append(items, &session)
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].UpdatedAt.After(items[j].UpdatedAt)
	})
	return items, nil
}

func (m *Manager) sessionPath(key string) (string, error) {
	if strings.TrimSpace(m.root.MetaDir()) == "" {
		return "", errors.New("managed dir required")
	}
	if key == "" {
		return "", errors.New("session key required")
	}
	if strings.Contains(key, "..") || strings.ContainsRune(key, filepath.Separator) || strings.Contains(key, "/") {
		return "", fmt.Errorf("invalid session key: %s", key)
	}
	name := fmt.Sprintf("session-%s.json", key)
	return filepath.ToSlash(filepath.Join("sessions", name)), nil
}

var errSessionNotFound = errors.New("session not found")

func (m *Manager) writeJSON(path string, value any) error {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return m.root.WriteMetaFile(path, payload)
}

func (m *Manager) enforceMaxIdleSessions(ctx context.Context, maxIdleSessions int) {
	if maxIdleSessions <= 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	sessions, err := m.listLocked()
	if err != nil {
		return
	}
	idleSessions := []*Session{}
	for _, s := range sessions {
		if s.Status == StatusIdle {
			idleSessions = append(idleSessions, s)
		}
	}
	if len(idleSessions) <= maxIdleSessions {
		return
	}
	sort.Slice(idleSessions, func(i, j int) bool {
		return idleSessions[i].UpdatedAt.Before(idleSessions[j].UpdatedAt)
	})
	toClose := len(idleSessions) - maxIdleSessions
	for i := 0; i < toClose; i++ {
		_, _ = m.closeLocked(ctx, idleSessions[i].Key)
	}
}

func (m *Manager) logSession(action, actor, sessionKey, agentName string, details map[string]any) {
	if m.audit == nil {
		return
	}
	_ = m.audit.LogSession(action, actor, sessionKey, agentName, details)
}

func generateKey() string {
	buf := make([]byte, 6)
	_, err := rand.Read(buf)
	if err != nil {
		return fmt.Sprintf("s-%d", time.Now().UTC().UnixNano())
	}
	return fmt.Sprintf("s-%d-%s", time.Now().UTC().UnixNano(), hex.EncodeToString(buf))
}
