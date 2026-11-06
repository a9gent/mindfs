package relay

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const defaultRelayBaseURL = "http://localhost:7331"

type Status struct {
	Bound             bool   `json:"relay_bound"`
	NoRelayer         bool   `json:"no_relayer"`
	TokenStationBound bool   `json:"token_station_bound"`
	PendingCode       string `json:"pending_code"`
	NodeName          string `json:"node_name"`
	NodeID            string `json:"node_id"`
	E2EENodeID        string `json:"e2ee_node_id,omitempty"`
	RelayBaseURL      string `json:"relay_base_url"`
	NodeURL           string `json:"node_url"`
	LastError         string `json:"last_error,omitempty"`
	E2EERequired      bool   `json:"e2ee_required"`
}

type TokenStationStatus struct {
	Bound        bool           `json:"bound"`
	PendingCode  string         `json:"pending_code,omitempty"`
	RelayBaseURL string         `json:"relay_base_url"`
	TopUpURL     string         `json:"topup_url"`
	UserInfo     map[string]any `json:"userinfo,omitempty"`
	LastError    string         `json:"last_error,omitempty"`
}

type Manager struct {
	service   *Service
	noRelayer bool
	relayBase string

	mu           sync.Mutex
	ctx          context.Context
	cancel       context.CancelFunc
	started      bool
	polling      bool
	pendingCode  string
	pendingSince time.Time
	nodeName     string
	lastError    string

	tokenStationPendingCode string
	tokenStationPolling     bool
	tokenStationLastError   string
}

func NewManager(localAddr string, noRelayer bool, relayBaseURL string, useTLS bool) (*Manager, error) {
	service, err := NewService(localAddr, useTLS)
	if err != nil {
		return nil, err
	}
	resolvedRelayBase := strings.TrimSpace(os.Getenv("MINDFS_RELAY_BASE_URL"))
	if resolvedRelayBase == "" {
		resolvedRelayBase = strings.TrimSpace(relayBaseURL)
	}
	manager := &Manager{
		service:   service,
		noRelayer: noRelayer,
		relayBase: strings.TrimSuffix(defaultIfEmpty(resolvedRelayBase, defaultRelayBaseURL), "/"),
		nodeName:  defaultNodeName(),
	}
	service.onConnectionModeSaved = manager.SetConnectionMode
	return manager, nil
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
	return nil
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()

	return m.statusLocked()
}

func (m *Manager) NoRelayer() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.noRelayer
}

func (m *Manager) StartBinding() (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.noRelayer {
		return m.statusLocked(), nil
	}
	creds, err := m.service.store.Load()
	if err != nil {
		m.lastError = err.Error()
		return m.statusLocked(), err
	}
	if creds.Relay.DeviceToken != "" && creds.Relay.Endpoint != "" {
		return m.statusLocked(), nil
	}
	if m.ctx == nil {
		return m.statusLocked(), errors.New("relay manager not started")
	}
	m.ensurePendingLocked()
	m.startPollingLocked(m.ctx, m.pendingCode)
	return m.statusLocked(), nil
}

func (m *Manager) TokenStationStatus(ctx context.Context) (TokenStationStatus, error) {
	m.mu.Lock()
	status := m.tokenStationStatusLocked()
	m.mu.Unlock()
	if !status.Bound {
		return status, nil
	}
	userInfo, err := m.TokenStationUserInfo(ctx, "")
	if err != nil {
		status.LastError = err.Error()
		return status, err
	}
	status.UserInfo = userInfo
	return status, nil
}

func (m *Manager) StartTokenStationBinding() (TokenStationStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.ctx == nil {
		return m.tokenStationStatusLocked(), errors.New("relay manager not started")
	}
	if creds, err := m.service.store.Load(); err == nil {
		if creds.Relay.DeviceToken != "" || creds.TokenStation.Token != "" {
			return m.tokenStationStatusLocked(), nil
		}
	} else {
		m.tokenStationLastError = err.Error()
		return m.tokenStationStatusLocked(), err
	}
	if strings.TrimSpace(m.tokenStationPendingCode) == "" {
		m.tokenStationPendingCode = generatePendingCode()
	}
	m.startTokenStationPollingLocked(m.ctx, m.tokenStationPendingCode)
	return m.tokenStationStatusLocked(), nil
}

func (m *Manager) TokenStationUserInfo(ctx context.Context, purpose string) (map[string]any, error) {
	creds, err := m.service.store.Load()
	if err != nil {
		return nil, err
	}
	return m.service.FetchTokenStationUserInfo(ctx, m.resolveRelayBase(), creds, purpose)
}

func (m *Manager) statusLocked() Status {
	status := Status{
		NoRelayer:         m.noRelayer,
		TokenStationBound: m.tokenStationBoundLocked(),
		PendingCode:       m.pendingCode,
		NodeName:          m.nodeName,
		RelayBaseURL:      m.resolveRelayBaseLocked(),
		LastError:         m.lastError,
	}
	if m.noRelayer {
		status.PendingCode = ""
		return status
	}
	creds, err := m.service.store.Load()
	if err == nil && creds.Relay.DeviceToken != "" && creds.Relay.Endpoint != "" {
		status.Bound = true
		status.NodeID = creds.Relay.NodeID
		if nodeName := strings.TrimSpace(creds.Relay.NodeName); nodeName != "" {
			status.NodeName = nodeName
		}
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

func (m *Manager) tokenStationBoundLocked() bool {
	creds, err := m.service.store.Load()
	return err == nil && (creds.Relay.DeviceToken != "" || creds.TokenStation.Token != "")
}

func (m *Manager) tokenStationStatusLocked() TokenStationStatus {
	status := TokenStationStatus{
		PendingCode:  m.tokenStationPendingCode,
		RelayBaseURL: m.resolveRelayBaseLocked(),
		TopUpURL:     m.resolveRelayBaseLocked(),
		LastError:    m.tokenStationLastError,
	}
	status.Bound = m.tokenStationBoundLocked()
	if status.Bound {
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
	if strings.TrimSpace(pendingCode) == "" || m.polling {
		return
	}
	m.polling = true
	go m.pollLoop(parent, pendingCode)
}

func (m *Manager) startTokenStationPollingLocked(parent context.Context, pendingCode string) {
	if strings.TrimSpace(pendingCode) == "" || m.tokenStationPolling {
		return
	}
	m.tokenStationPolling = true
	go m.tokenStationPollLoop(parent, pendingCode)
}

func (m *Manager) tokenStationPollLoop(parent context.Context, pendingCode string) {
	defer func() {
		m.mu.Lock()
		m.tokenStationPolling = false
		m.mu.Unlock()
	}()

	m.runBindPollLoop(parent, pendingCode, "token_station",
		func(result BindPollResult) error {
			return m.service.store.SaveTokenStation(result.TokenStationToken)
		},
		func(status string) {
			m.mu.Lock()
			m.tokenStationPendingCode = ""
			m.tokenStationLastError = status
			m.mu.Unlock()
		},
		func(message string) {
			m.mu.Lock()
			m.tokenStationLastError = message
			m.mu.Unlock()
		},
	)
}

func (m *Manager) pollLoop(parent context.Context, pendingCode string) {
	defer m.finishPolling(pendingCode)

	m.runBindPollLoop(parent, pendingCode, "",
		func(result BindPollResult) error {
			return m.service.store.Save(Credentials{Relay: result.Credentials})
		},
		func(status string) {
			m.mu.Lock()
			m.pendingCode = ""
			m.lastError = status
			alreadyStarted := status == "" && m.cancel != nil
			m.mu.Unlock()
			if status != "" {
				return
			}
			if alreadyStarted {
				m.restart()
				return
			}
			m.mu.Lock()
			if m.ctx != nil {
				m.startLocked(m.ctx)
			}
			m.mu.Unlock()
		},
		func(message string) {
			m.mu.Lock()
			m.lastError = message
			m.mu.Unlock()
		},
	)
}

func (m *Manager) runBindPollLoop(
	parent context.Context,
	pendingCode string,
	purpose string,
	onConfirmed func(BindPollResult) error,
	onFinished func(status string),
	onError func(message string),
) {
	delay := time.Duration(0)
	for {
		if delay > 0 {
			select {
			case <-parent.Done():
				return
			case <-time.After(delay):
			}
		} else if parent.Err() != nil {
			return
		}

		result, err := m.service.PollBindPurpose(parent, m.resolveRelayBase(), pendingCode, purpose)
		if err != nil {
			delay = nextDelay(delay)
			onError(err.Error())
			continue
		}

		switch result.Status {
		case "pending":
			delay = result.NextPollAfter
			if delay <= 0 {
				delay = 3 * time.Second
			}
		case "confirmed":
			if err := onConfirmed(result); err != nil {
				delay = nextDelay(delay)
				onError(err.Error())
				continue
			}
			onFinished("")
			return
		case "claimed", "expired", "revoked":
			onFinished(result.Status)
			return
		default:
			delay = nextDelay(delay)
		}
	}
}

func (m *Manager) finishPolling(pendingCode string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.polling = false
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
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	if clearErr := m.service.store.Clear(); clearErr != nil {
		log.Printf("[relay] clear credentials failed after permanent error: %v", clearErr)
	}
	m.lastError = err.Error()
	m.mu.Unlock()

	log.Printf("[relay] credentials invalidated, rebinding required: %v", err)
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
