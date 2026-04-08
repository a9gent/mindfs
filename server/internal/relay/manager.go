package relay

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"log"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const defaultRelayBaseURL = "http://localhost:7331"

type Status struct {
	Bound        bool   `json:"relay_bound"`
	NoRelayer    bool   `json:"no_relayer"`
	PendingCode  string `json:"pending_code"`
	NodeName     string `json:"node_name"`
	NodeID       string `json:"node_id"`
	RelayBaseURL string `json:"relay_base_url"`
	NodeURL      string `json:"node_url"`
	LastError    string `json:"last_error,omitempty"`
}

type Manager struct {
	service   *Service
	noRelayer bool
	relayBase string

	mu           sync.Mutex
	ctx          context.Context
	cancel       context.CancelFunc
	started      bool
	pendingCode  string
	pendingSince time.Time
	nodeName     string
	lastError    string
}

func NewManager(localAddr string, noRelayer bool, relayBaseURL string) (*Manager, error) {
	service, err := NewService(localAddr)
	if err != nil {
		return nil, err
	}
	resolvedRelayBase := strings.TrimSpace(os.Getenv("MINDFS_RELAY_BASE_URL"))
	if resolvedRelayBase == "" {
		resolvedRelayBase = strings.TrimSpace(relayBaseURL)
	}
	return &Manager{
		service:   service,
		noRelayer: noRelayer,
		relayBase: strings.TrimSuffix(defaultIfEmpty(resolvedRelayBase, defaultRelayBaseURL), "/"),
		nodeName:  defaultNodeName(),
	}, nil
}

func (m *Manager) Start(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.started {
		return nil
	}
	m.started = true
	m.ctx = ctx

	creds, err := m.service.store.Load()
	if err != nil {
		m.started = false
		m.ctx = nil
		return err
	}
	if relayBaseMismatch(m.relayBase, creds.Relay.Endpoint) {
		if clearErr := m.service.store.Clear(); clearErr != nil {
			m.started = false
			m.ctx = nil
			return clearErr
		}
		log.Printf("[relay] configured relay base changed, clearing stored credentials and requiring rebind")
		m.lastError = "relay base changed, rebinding required"
		creds = Credentials{}
	}
	if m.noRelayer {
		return nil
	}
	if creds.Relay.DeviceToken != "" && creds.Relay.Endpoint != "" {
		m.startLocked(ctx)
		return nil
	}
	m.ensurePendingLocked()
	m.startPollingLocked(ctx, m.pendingCode)
	return nil
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()

	status := Status{
		NoRelayer:    m.noRelayer,
		PendingCode:  m.pendingCode,
		NodeName:     m.nodeName,
		RelayBaseURL: m.resolveRelayBaseLocked(),
		LastError:    m.lastError,
	}
	if m.noRelayer {
		status.PendingCode = ""
		return status
	}
	creds, err := m.service.store.Load()
	if err == nil && creds.Relay.DeviceToken != "" && creds.Relay.Endpoint != "" {
		status.Bound = true
		status.NodeID = creds.Relay.NodeID
		if status.RelayBaseURL == "" {
			status.RelayBaseURL = endpointBaseURL(creds.Relay.Endpoint)
		}
		if status.RelayBaseURL != "" && status.NodeID != "" {
			status.NodeURL = strings.TrimSuffix(status.RelayBaseURL, "/") + "/n/" + status.NodeID + "/"
		}
		status.PendingCode = ""
	}
	return status
}

func (m *Manager) startLocked(parent context.Context) {
	runCtx, cancel := context.WithCancel(parent)
	m.ctx = parent
	m.cancel = cancel
	go func() {
		if err := m.service.Run(runCtx); err != nil && runCtx.Err() == nil {
			if isPermanentRelayError(err) {
				m.handlePermanentRelayError(err)
				return
			}
			log.Printf("[relay] stopped: %v", err)
		}
	}()
}

func (m *Manager) startPollingLocked(parent context.Context, pendingCode string) {
	if strings.TrimSpace(pendingCode) == "" {
		return
	}
	go m.pollLoop(parent, pendingCode)
}

func (m *Manager) pollLoop(parent context.Context, pendingCode string) {
	delay := 2 * time.Second
	for {
		select {
		case <-parent.Done():
			return
		case <-time.After(delay):
		}

		result, err := m.service.PollBind(parent, m.resolveRelayBase(), pendingCode)
		if err != nil {
			delay = nextDelay(delay)
			m.mu.Lock()
			m.lastError = err.Error()
			m.mu.Unlock()
			continue
		}

		switch result.Status {
		case "pending":
			delay = result.NextPollAfter
			if delay <= 0 {
				delay = 2 * time.Second
			}
		case "confirmed":
			if err := m.service.store.Save(Credentials{Relay: result.Credentials}); err != nil {
				m.mu.Lock()
				m.lastError = err.Error()
				m.mu.Unlock()
				delay = nextDelay(delay)
				continue
			}
			m.mu.Lock()
			m.pendingCode = ""
			m.lastError = ""
			alreadyStarted := m.cancel != nil
			m.mu.Unlock()
			if alreadyStarted {
				m.restart()
			} else {
				m.mu.Lock()
				if m.ctx != nil {
					m.startLocked(m.ctx)
				}
				m.mu.Unlock()
			}
			return
		case "claimed", "expired", "revoked":
			m.mu.Lock()
			m.lastError = result.Status
			m.pendingCode = ""
			m.mu.Unlock()
			return
		default:
			delay = nextDelay(delay)
		}
	}
}

func (m *Manager) restart() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	if m.ctx != nil {
		m.startLocked(m.ctx)
	}
}

func (m *Manager) handlePermanentRelayError(err error) {
	m.mu.Lock()
	parent := m.ctx
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	if clearErr := m.service.store.Clear(); clearErr != nil {
		log.Printf("[relay] clear credentials failed after permanent error: %v", clearErr)
	}
	m.ensurePendingLocked()
	m.lastError = err.Error()
	pendingCode := m.pendingCode
	m.mu.Unlock()

	log.Printf("[relay] credentials invalidated, rebinding required: %v", err)
	if parent != nil && strings.TrimSpace(pendingCode) != "" {
		m.startPollingLocked(parent, pendingCode)
	}
}

func (m *Manager) ensurePendingLocked() {
	if strings.TrimSpace(m.pendingCode) != "" {
		return
	}
	m.pendingCode = generatePendingCode()
	m.pendingSince = time.Now().UTC()
}

func (m *Manager) resolveRelayBase() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.resolveRelayBaseLocked()
}

func (m *Manager) resolveRelayBaseLocked() string {
	if strings.TrimSpace(m.relayBase) != "" {
		return strings.TrimSuffix(m.relayBase, "/")
	}
	creds, err := m.service.store.Load()
	if err != nil {
		return ""
	}
	return endpointBaseURL(creds.Relay.Endpoint)
}

func relayBaseMismatch(configuredBase, endpoint string) bool {
	configuredBase = strings.TrimSuffix(strings.TrimSpace(configuredBase), "/")
	endpointBase := strings.TrimSuffix(strings.TrimSpace(endpointBaseURL(endpoint)), "/")
	if configuredBase == "" || endpointBase == "" {
		return false
	}
	return configuredBase != endpointBase
}

func defaultIfEmpty(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func nextDelay(current time.Duration) time.Duration {
	if current <= 0 {
		return 2 * time.Second
	}
	if current < 10*time.Second {
		current *= 2
	}
	if current > 10*time.Second {
		current = 10 * time.Second
	}
	return current
}

func generatePendingCode() string {
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return "pc_" + base64.RawURLEncoding.EncodeToString(buf)
}

func defaultNodeName() string {
	name, err := os.Hostname()
	if err != nil {
		return "localhost"
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return "localhost"
	}
	return name
}

func endpointBaseURL(endpoint string) string {
	u, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil {
		return ""
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	default:
		return ""
	}
	u.Path = ""
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimSuffix(u.String(), "/")
}
