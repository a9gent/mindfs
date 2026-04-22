package e2ee

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

const idleTTL = 24 * time.Hour

type Session struct {
	ID         string
	NodeID     string
	Key        []byte
	CreatedAt  time.Time
	LastSeenAt time.Time
}

type Manager struct {
	mu        sync.RWMutex
	cfg       Config
	sessions  map[string]*Session
	clientIDs map[string]string
}

func NewManager(cfg Config) *Manager {
	return &Manager{
		cfg:       cfg,
		sessions:  map[string]*Session{},
		clientIDs: map[string]string{},
	}
}

func (m *Manager) Enabled() bool {
	return m != nil && m.cfg.Enabled && m.cfg.PairingSecret != ""
}

func (m *Manager) NodeID() string {
	if m == nil {
		return ""
	}
	return m.cfg.NodeID
}

func (m *Manager) PairingSecret() string {
	if m == nil {
		return ""
	}
	return m.cfg.PairingSecret
}

func (m *Manager) OpenSessionForClient(clientID string, key DerivedKey) (*Session, error) {
	if !m.Enabled() {
		return nil, errors.New("e2ee disabled")
	}
	if clientID == "" {
		return nil, errors.New("client_id required")
	}
	sessionID, err := randomSessionID()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	sess := &Session{
		ID:         sessionID,
		NodeID:     m.cfg.NodeID,
		Key:        append([]byte(nil), key.Transport...),
		CreatedAt:  now,
		LastSeenAt: now,
	}
	m.mu.Lock()
	if previousID := m.clientIDs[clientID]; previousID != "" {
		delete(m.sessions, previousID)
	}
	m.sessions[sess.ID] = sess
	m.clientIDs[clientID] = sess.ID
	m.mu.Unlock()
	return cloneSession(sess), nil
}

func (m *Manager) SessionForClient(clientID string) (*Session, error) {
	if !m.Enabled() {
		return nil, errors.New("e2ee_required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	sessionID := m.clientIDs[clientID]
	if sessionID == "" {
		return nil, errors.New("e2ee_session_missing")
	}
	sess := m.sessions[sessionID]
	if sess == nil {
		delete(m.clientIDs, clientID)
		return nil, errors.New("e2ee_session_missing")
	}
	if expiredLocked(sess) {
		delete(m.sessions, sessionID)
		delete(m.clientIDs, clientID)
		return nil, errors.New("e2ee_session_expired")
	}
	sess.LastSeenAt = time.Now().UTC()
	return cloneSession(sess), nil
}

func (m *Manager) CleanupExpired() {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, sess := range m.sessions {
		if expiredLocked(sess) {
			delete(m.sessions, id)
			m.clearClientBindingLocked(id)
		}
	}
}

func (m *Manager) StartCleanup(stop <-chan struct{}) {
	if m == nil {
		return
	}
	ticker := time.NewTicker(time.Hour)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				m.CleanupExpired()
			case <-stop:
				return
			}
		}
	}()
}

func expiredLocked(sess *Session) bool {
	if sess == nil {
		return true
	}
	return time.Since(sess.LastSeenAt) > idleTTL
}

func (m *Manager) clearClientBindingLocked(sessionID string) {
	for clientID, current := range m.clientIDs {
		if current == sessionID {
			delete(m.clientIDs, clientID)
		}
	}
}

func cloneSession(sess *Session) *Session {
	if sess == nil {
		return nil
	}
	return &Session{
		ID:         sess.ID,
		NodeID:     sess.NodeID,
		Key:        append([]byte(nil), sess.Key...),
		CreatedAt:  sess.CreatedAt,
		LastSeenAt: sess.LastSeenAt,
	}
}

func randomSessionID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
