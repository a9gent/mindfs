package relay

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
)

const (
	wsFrameData  byte = 1
	wsFrameClose byte = 2

	relayReconnectInitialBackoff = time.Second
	relayReconnectMaxBackoff     = 30 * time.Second
	relayReconnectStableDuration = time.Minute
)

const relayDeviceIDHeader = "X-MindFS-Device-ID"

type Service struct {
	localAddr string
	localURL  string
	store     *CredentialsStore
	client    *http.Client
	useTLS    bool
}

type credentialResponse struct {
	DeviceToken string `json:"device_token"`
	NodeID      string `json:"node_id"`
	Endpoint    string `json:"endpoint"`
}

type bindPollResponse struct {
	Status          string `json:"status"`
	NextPollAfterMS int64  `json:"next_poll_after_ms"`
	credentialResponse
}

type BindPollResult struct {
	Status        string
	NextPollAfter time.Duration
	Credentials   RelayCredentials
}

func NewService(localAddr string, useTLS bool) (*Service, error) {
	store, err := NewCredentialsStore()
	if err != nil {
		return nil, err
	}
	if _, err := getOrCreateDeviceID(); err != nil {
		return nil, err
	}

	var client *http.Client
	if useTLS {
		// InsecureSkipVerify is used because the relay connects to the local
		// MindFS server (loopback or same machine), which may present a
		// self-signed certificate. No traffic leaves the host.
		client = &http.Client{
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		}
	} else {
		// Do not apply a whole-request timeout here. Relay traffic can include
		// large static assets and streamed responses; http.Client.Timeout would
		// abort the body read mid-transfer and surface as a 502 on the relayed
		// path even when the local server is healthy.
		client = &http.Client{}
	}

	return &Service{
		localAddr: localAddr,
		localURL:  addrToURL(localAddr, "", useTLS),
		store:     store,
		client:    client,
		useTLS:    useTLS,
	}, nil
}

func (s *Service) Run(ctx context.Context) error {
	creds, err := s.store.Load()
	if err != nil {
		return err
	}
	if creds.Relay.DeviceToken == "" || creds.Relay.Endpoint == "" {
		return nil
	}
	if err := s.waitForLocalServer(ctx); err != nil {
		return err
	}

	backoff := relayReconnectInitialBackoff
	for {
		startedAt := time.Now()
		err := s.runSession(ctx, creds.Relay)
		if ctx.Err() != nil {
			return nil
		}
		if isPermanentRelayError(err) {
			return err
		}
		if time.Since(startedAt) >= relayReconnectStableDuration {
			backoff = relayReconnectInitialBackoff
		}
		log.Printf("[relay] reconnecting after error in %s: %v", backoff, err)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		if backoff < relayReconnectMaxBackoff {
			backoff *= 2
			if backoff > relayReconnectMaxBackoff {
				backoff = relayReconnectMaxBackoff
			}
		}
	}
}

func (s *Service) PollBind(ctx context.Context, baseURL, pendingCode string) (BindPollResult, error) {
	pollURL, err := buildBindPollURL(baseURL, pendingCode)
	if err != nil {
		return BindPollResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
	if err != nil {
		return BindPollResult{}, err
	}
	if err := s.attachDeviceID(req); err != nil {
		return BindPollResult{}, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return BindPollResult{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return BindPollResult{}, fmt.Errorf("relay bind poll failed: %s %s", resp.Status, strings.TrimSpace(string(payload)))
	}

	var out bindPollResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return BindPollResult{}, err
	}
	result := BindPollResult{
		Status:        strings.TrimSpace(out.Status),
		NextPollAfter: time.Duration(out.NextPollAfterMS) * time.Millisecond,
	}
	if result.Status == "confirmed" {
		result.Credentials = RelayCredentials{
			DeviceToken: strings.TrimSpace(out.DeviceToken),
			NodeID:      strings.TrimSpace(out.NodeID),
			Endpoint:    strings.TrimSpace(out.Endpoint),
		}
	}
	return result, nil
}

func (s *Service) attachDeviceID(req *http.Request) error {
	if s == nil || req == nil {
		return nil
	}
	deviceID, err := getOrCreateDeviceID()
	if err != nil {
		return err
	}
	if strings.TrimSpace(deviceID) != "" {
		req.Header.Set(relayDeviceIDHeader, deviceID)
	}
	return nil
}

func buildBindPollURL(baseURL, pendingCode string) (string, error) {
	baseURL = strings.TrimSuffix(strings.TrimSpace(baseURL), "/")
	pendingCode = strings.TrimSpace(pendingCode)
	if baseURL == "" {
		return "", errors.New("relay base URL required")
	}
	if pendingCode == "" {
		return "", errors.New("pending code required")
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http", "https":
		u.Path = strings.TrimSuffix(u.Path, "/") + "/api/bind/poll"
		q := u.Query()
		q.Set("code", pendingCode)
		u.RawQuery = q.Encode()
		u.Fragment = ""
		return u.String(), nil
	default:
		return "", fmt.Errorf("unsupported relay base URL scheme: %s", u.Scheme)
	}
}

func (s *Service) runSession(ctx context.Context, creds RelayCredentials) error {
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+creds.DeviceToken)
	conn, resp, err := websocket.DefaultDialer.DialContext(ctx, creds.Endpoint, headers)
	if err != nil {
		if resp != nil && strings.TrimSpace(resp.Status) != "" {
			return fmt.Errorf("relay websocket dial failed: %s: %w", resp.Status, err)
		}
		return err
	}
	defer conn.Close()

	wsConn := NewWebSocketNetConn(conn)
	yamuxConfig := yamux.DefaultConfig()
	yamuxConfig.ConnectionWriteTimeout = 60 * time.Second
	yamuxConfig.EnableKeepAlive = true
	yamuxConfig.KeepAliveInterval = 30 * time.Second
	muxSession, err := yamux.Client(wsConn, yamuxConfig)
	if err != nil {
		return err
	}
	defer muxSession.Close()

	errCh := make(chan error, 1)
	go func() {
		for {
			stream, err := muxSession.Accept()
			if err != nil {
				errCh <- err
				return
			}
			go func() {
				if err := s.handleStream(ctx, stream); err != nil {
					log.Printf("[relay] stream failed: %v", err)
				}
			}()
		}
	}()

	select {
	case <-ctx.Done():
		return nil
	case err := <-errCh:
		return err
	}
}

func (s *Service) handleStream(ctx context.Context, stream net.Conn) error {
	defer stream.Close()

	reader := bufio.NewReader(stream)
	req, err := http.ReadRequest(reader)
	if err != nil {
		return err
	}
	req = req.WithContext(ctx)
	if websocket.IsWebSocketUpgrade(req) {
		return s.proxyWebSocket(req, stream)
	}
	return s.proxyHTTP(req, stream)
}

func (s *Service) proxyHTTP(req *http.Request, stream io.Writer) error {
	targetURL, err := localTargetURL(s.localURL, req.URL)
	if err != nil {
		return err
	}
	outbound := req.Clone(req.Context())
	outbound.URL = targetURL
	outbound.RequestURI = ""
	outbound.Host = targetURL.Host

	resp, err := s.client.Do(outbound)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return resp.Write(stream)
}

func (s *Service) proxyWebSocket(req *http.Request, stream io.ReadWriter) error {
	targetURL, err := websocketTargetURL(s.localURL, req.URL)
	if err != nil {
		return err
	}
	headers := cloneHeader(req.Header)
	headers.Del("Connection")
	headers.Del("Upgrade")
	headers.Del("Sec-WebSocket-Key")
	headers.Del("Sec-WebSocket-Version")
	headers.Del("Sec-WebSocket-Extensions")

	dialer := *websocket.DefaultDialer
	if s.useTLS {
		// InsecureSkipVerify is used because the relay connects to the local
		// MindFS server (loopback or same machine), which may present a
		// self-signed certificate. No traffic leaves the host.
		dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	if protocol := strings.TrimSpace(req.Header.Get("Sec-WebSocket-Protocol")); protocol != "" {
		dialer.Subprotocols = splitHeaderValues(protocol)
	}
	localConn, resp, err := dialer.DialContext(req.Context(), targetURL, headers)
	if err != nil {
		if resp != nil {
			_ = resp.Write(stream)
		}
		return err
	}
	defer localConn.Close()

	if resp == nil {
		return errors.New("relay websocket upgrade missing response")
	}
	if err := resp.Write(stream); err != nil {
		return err
	}

	errCh := make(chan error, 2)
	go bridgeStreamToWebSocket(stream, localConn, errCh)
	go bridgeWebSocketToStream(localConn, stream, errCh)
	err = <-errCh
	_ = writeWSCloseFrame(stream, websocket.CloseNormalClosure, "connector_closed")
	return err
}

func (s *Service) waitForLocalServer(ctx context.Context) error {
	healthURL := strings.TrimSuffix(s.localURL, "/") + "/health"
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
		if err != nil {
			return err
		}
		resp, err := s.client.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func addrToURL(addr, path string, useTLS bool) string {
	if strings.HasPrefix(addr, "http://") || strings.HasPrefix(addr, "https://") {
		return strings.TrimSuffix(addr, "/") + path
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		host = "localhost"
		port = strings.TrimPrefix(addr, ":")
	}
	if host == "" {
		host = "localhost"
	}
	if host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	if port == "" {
		port = "7331"
	}
	scheme := "http"
	if useTLS {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s:%s%s", scheme, host, port, path)
}

func localTargetURL(base string, requestURL *url.URL) (*url.URL, error) {
	target, err := url.Parse(strings.TrimSuffix(base, "/") + requestURL.RequestURI())
	if err != nil {
		return nil, err
	}
	target.Fragment = ""
	return target, nil
}

func websocketTargetURL(base string, requestURL *url.URL) (string, error) {
	target, err := localTargetURL(base, requestURL)
	if err != nil {
		return "", err
	}
	switch target.Scheme {
	case "http":
		target.Scheme = "ws"
	case "https":
		target.Scheme = "wss"
	default:
		return "", fmt.Errorf("unsupported websocket target scheme: %s", target.Scheme)
	}
	return target.String(), nil
}

func splitHeaderValues(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func cloneHeader(header http.Header) http.Header {
	clone := make(http.Header, len(header))
	for key, values := range header {
		clone[key] = append([]string(nil), values...)
	}
	return clone
}

func isPermanentRelayError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "401") || strings.Contains(msg, "403") || strings.Contains(msg, "404")
}
