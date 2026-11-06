package relay

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	networkAuto uint32 = iota
	networkDirect
	networkSystem
	networkAutoProxy
)

const relayDirectTimeout = 5 * time.Second

// Auto starts directly and remembers a successful proxy fallback until the mode
// changes or MindFS restarts. HTTP requests and WebSockets share this decision.
type relayNetwork struct{ state atomic.Uint32 }

func networkMode(mode string) uint32 {
	switch mode {
	case "direct":
		return networkDirect
	case "system":
		return networkSystem
	default:
		return networkAuto
	}
}

func networkFailure(ctx context.Context, err error) bool {
	if err == nil || ctx.Err() != nil {
		return false
	}
	var networkError net.Error
	return errors.As(err, &networkError) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
}

type relayTransport struct {
	network                    *relayNetwork
	direct, autoDirect, system *http.Transport
}

func (n *relayNetwork) transport() *relayTransport {
	direct := http.DefaultTransport.(*http.Transport).Clone()
	direct.Proxy = nil
	autoDirect := direct.Clone()
	autoDirect.DialContext = (&net.Dialer{Timeout: relayDirectTimeout, KeepAlive: 30 * time.Second}).DialContext
	autoDirect.TLSHandshakeTimeout = relayDirectTimeout
	autoDirect.ResponseHeaderTimeout = relayDirectTimeout
	system := http.DefaultTransport.(*http.Transport).Clone()
	system.Proxy = http.ProxyFromEnvironment
	return &relayTransport{network: n, direct: direct, autoDirect: autoDirect, system: system}
}

func (t *relayTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	state := t.network.state.Load()
	if state == networkSystem || state == networkAutoProxy {
		return t.system.RoundTrip(req)
	}
	transport := t.direct
	if state == networkAuto {
		transport = t.autoDirect
	}
	resp, err := transport.RoundTrip(req)
	if state != networkAuto || !networkFailure(req.Context(), err) {
		return resp, err
	}
	proxy, proxyErr := http.ProxyFromEnvironment(req)
	if proxyErr != nil || proxy == nil {
		return resp, err
	}
	// Only retry replayable, idempotent requests. Relay mutations use PUT/DELETE.
	switch req.Method {
	case http.MethodGet, http.MethodHead, http.MethodPut, http.MethodDelete, http.MethodOptions:
	default:
		return resp, err
	}
	retry := req.Clone(req.Context())
	if req.Body != nil && req.Body != http.NoBody {
		if req.GetBody == nil {
			return resp, err
		}
		retry.Body, proxyErr = req.GetBody()
		if proxyErr != nil {
			return resp, err
		}
	}
	resp, err = t.system.RoundTrip(retry)
	if err == nil && resp.StatusCode < http.StatusInternalServerError {
		t.network.state.CompareAndSwap(networkAuto, networkAutoProxy)
	}
	return resp, err
}

func (t *relayTransport) CloseIdleConnections() {
	t.direct.CloseIdleConnections()
	t.autoDirect.CloseIdleConnections()
	t.system.CloseIdleConnections()
}

func (n *relayNetwork) dialWebSocket(ctx context.Context, endpoint string, headers http.Header, base websocket.Dialer) (*websocket.Conn, *http.Response, error) {
	state := n.state.Load()
	base.Proxy = http.ProxyFromEnvironment
	if state == networkSystem || state == networkAutoProxy {
		return base.DialContext(ctx, endpoint, headers)
	}
	direct := base
	direct.Proxy = nil
	if state == networkAuto {
		direct.HandshakeTimeout = relayDirectTimeout
	}
	conn, resp, err := direct.DialContext(ctx, endpoint, headers)
	if state != networkAuto || resp != nil || !networkFailure(ctx, err) {
		return conn, resp, err
	}
	proxyURL := strings.Replace(strings.Replace(endpoint, "wss://", "https://", 1), "ws://", "http://", 1)
	req, parseErr := http.NewRequestWithContext(ctx, http.MethodGet, proxyURL, nil)
	if parseErr != nil {
		return conn, resp, err
	}
	proxy, proxyErr := http.ProxyFromEnvironment(req)
	if proxyErr != nil || proxy == nil {
		return conn, resp, err
	}
	conn, resp, err = base.DialContext(ctx, endpoint, headers)
	if err == nil {
		n.state.CompareAndSwap(networkAuto, networkAutoProxy)
	}
	return conn, resp, err
}

func (m *Manager) SetConnectionMode(mode string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next := networkMode(mode)
	current := m.service.network.state.Load()
	if current == next || (current == networkAutoProxy && next == networkAuto) {
		return
	}
	m.service.network.state.Store(next)
	m.service.client.CloseIdleConnections()
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
		if !m.noRelayer && m.ctx != nil && m.ctx.Err() == nil {
			m.startLocked(m.ctx)
		}
	}
}
