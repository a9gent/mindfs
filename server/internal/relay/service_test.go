package relay

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestCredentialsStoreSaveLoad(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("HOME", configRoot)

	store, err := NewCredentialsStore()
	if err != nil {
		t.Fatalf("NewCredentialsStore() error = %v", err)
	}

	input := Credentials{
		Relay: RelayCredentials{
			DeviceToken: "dev_123",
			NodeID:      "node_123",
			Endpoint:    "wss://relay.example.com/ws/connector",
		},
	}
	if err := store.Save(input); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got.Relay != input.Relay {
		t.Fatalf("Load() = %+v, want %+v", got.Relay, input.Relay)
	}

	if _, err := os.Stat(store.filePath); err != nil {
		t.Fatalf("credentials file missing: %v", err)
	}
}

func TestCredentialsStoreClear(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("HOME", configRoot)

	store, err := NewCredentialsStore()
	if err != nil {
		t.Fatalf("NewCredentialsStore() error = %v", err)
	}
	if err := store.Save(Credentials{
		Relay: RelayCredentials{
			DeviceToken: "dev_123",
			NodeID:      "node_123",
			Endpoint:    "wss://relay.example.com/ws/connector",
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := store.Clear(); err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	got, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got.Relay.DeviceToken != "" || got.Relay.Endpoint != "" || got.Relay.NodeID != "" {
		t.Fatalf("expected empty credentials after clear, got %+v", got.Relay)
	}
}

func TestBuildBindPollURL(t *testing.T) {
	got, err := buildBindPollURL("https://relay.example.com", "pc_123")
	if err != nil {
		t.Fatalf("buildBindPollURL() error = %v", err)
	}
	if got != "https://relay.example.com/api/bind/poll?code=pc_123" {
		t.Fatalf("buildBindPollURL() = %q", got)
	}
}

func TestServicePollBind(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("HOME", configRoot)

	svc, err := NewService(":7331")
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	svc.client = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.String() != "https://relay.example.com/api/bind/poll?code=pc_live" {
				t.Fatalf("unexpected poll URL: %s", req.URL.String())
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Status:     "200 OK",
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"status":"confirmed","device_token":"dev_live","node_id":"node_live","endpoint":"wss://relay.example.com/ws/connector"}`)),
			}, nil
		}),
	}

	result, err := svc.PollBind(context.Background(), "https://relay.example.com", "pc_live")
	if err != nil {
		t.Fatalf("PollBind() error = %v", err)
	}
	if result.Status != "confirmed" {
		t.Fatalf("status = %q", result.Status)
	}
	if result.Credentials.DeviceToken != "dev_live" {
		t.Fatalf("device token = %q", result.Credentials.DeviceToken)
	}
}

func TestManagerStartGeneratesPendingCode(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("HOME", configRoot)

	manager, err := NewManager(":7331", false, "https://relay.example.com")
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := manager.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	status := manager.Status()
	if status.PendingCode == "" {
		t.Fatal("expected pending code")
	}
	if status.Bound {
		t.Fatal("expected unbound status")
	}
	if status.RelayBaseURL != "https://relay.example.com" {
		t.Fatalf("relay base url = %q", status.RelayBaseURL)
	}
	if status.NodeName == "" {
		t.Fatal("expected node name")
	}
}

func TestManagerNoRelayerDoesNotGeneratePendingCode(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("HOME", configRoot)

	manager, err := NewManager(":7331", true, "https://relay.example.com")
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := manager.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	status := manager.Status()
	if status.PendingCode != "" {
		t.Fatalf("expected no pending code, got %q", status.PendingCode)
	}
	if !status.NoRelayer {
		t.Fatal("expected no-relayer status")
	}
}

func TestManagerPollConfirmedStartsRelay(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("HOME", configRoot)

	manager, err := NewManager(":7331", false, "https://relay.example.com")
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}

	requests := make(chan string, 8)
	manager.service.client = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			requests <- req.URL.String()
			switch {
			case strings.HasPrefix(req.URL.String(), "https://relay.example.com/api/bind/poll?code=pc_"):
				return &http.Response{
					StatusCode: http.StatusOK,
					Status:     "200 OK",
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(`{"status":"confirmed","device_token":"dev_live","node_id":"node_live","endpoint":"wss://relay.example.com/ws/connector"}`)),
				}, nil
			case req.URL.String() == "http://localhost:7331/health":
				return &http.Response{
					StatusCode: http.StatusOK,
					Status:     "200 OK",
					Header:     http.Header{},
					Body:       io.NopCloser(strings.NewReader("ok")),
				}, nil
			default:
				return nil, context.Canceled
			}
		}),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := manager.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	timeout := time.After(4 * time.Second)
	for {
		select {
		case raw := <-requests:
			if raw == "http://localhost:7331/health" {
				creds, err := manager.service.store.Load()
				if err != nil {
					t.Fatalf("Load() error = %v", err)
				}
				if creds.Relay.NodeID != "node_live" {
					t.Fatalf("node id = %q", creds.Relay.NodeID)
				}
				return
			}
		case <-timeout:
			t.Fatal("relay did not start after confirmed poll")
		}
	}
}

func TestManagerPollTerminalBindStatusRefreshesPendingCode(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("HOME", configRoot)

	manager, err := NewManager(":7331", false, "https://relay.example.com")
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}

	requests := make(chan string, 4)
	manager.service.client = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if strings.HasPrefix(req.URL.String(), "https://relay.example.com/api/bind/poll?code=pc_") {
				requests <- req.URL.String()
				return &http.Response{
					StatusCode: http.StatusOK,
					Status:     "200 OK",
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(`{"status":"expired"}`)),
				}, nil
			}
			return nil, context.Canceled
		}),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := manager.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	firstPendingCode := manager.Status().PendingCode
	if firstPendingCode == "" {
		t.Fatal("expected initial pending code")
	}

	timeout := time.After(5 * time.Second)
	for {
		select {
		case <-requests:
			status := manager.Status()
			if status.LastError != "expired" {
				continue
			}
			if status.PendingCode == "" {
				t.Fatal("expected refreshed pending code")
			}
			if status.PendingCode == firstPendingCode {
				t.Fatalf("pending code was not refreshed: %q", status.PendingCode)
			}
			return
		case <-timeout:
			t.Fatal("pending code was not refreshed after expired bind status")
		}
	}
}

func TestManagerDefaultsRelayBaseToLocalhost(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("HOME", configRoot)

	manager, err := NewManager(":7331", false, "")
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := manager.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	status := manager.Status()
	if status.RelayBaseURL != defaultRelayBaseURL {
		t.Fatalf("relay base url = %q, want %q", status.RelayBaseURL, defaultRelayBaseURL)
	}
	if status.PendingCode == "" {
		t.Fatal("expected pending code")
	}
}

func TestManagerPermanentRelayErrorClearsCredentialsAndRebinds(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("HOME", configRoot)

	manager, err := NewManager(":7331", false, "https://relay.example.com")
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	if err := manager.service.store.Save(Credentials{
		Relay: RelayCredentials{
			DeviceToken: "dev_live",
			NodeID:      "node_live",
			Endpoint:    "wss://relay.example.com/ws/connector",
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	pollSeen := make(chan string, 1)
	manager.service.client = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			switch {
			case strings.HasPrefix(req.URL.String(), "http://localhost:7331/health"):
				return &http.Response{
					StatusCode: http.StatusOK,
					Status:     "200 OK",
					Header:     http.Header{},
					Body:       io.NopCloser(strings.NewReader("ok")),
				}, nil
			case strings.HasPrefix(req.URL.String(), "https://relay.example.com/api/bind/poll?code=pc_"):
				select {
				case pollSeen <- req.URL.String():
				default:
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Status:     "200 OK",
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(`{"status":"pending","next_poll_after_ms":2000}`)),
				}, nil
			default:
				return nil, nil
			}
		}),
	}

	manager.handlePermanentRelayError(errors.New("websocket: bad handshake (404 Not Found)"))

	status := manager.Status()
	if status.Bound {
		t.Fatal("expected unbound status after permanent relay error")
	}
	if status.PendingCode == "" {
		t.Fatal("expected pending code after permanent relay error")
	}
	if !strings.Contains(status.LastError, "404") {
		t.Fatalf("last error = %q", status.LastError)
	}
	creds, err := manager.service.store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if creds.Relay.DeviceToken != "" || creds.Relay.Endpoint != "" {
		t.Fatalf("expected cleared credentials, got %+v", creds.Relay)
	}
}

func TestManagerStartClearsCredentialsWhenRelayBaseChanges(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("HOME", configRoot)

	manager, err := NewManager(":7331", false, "https://relay-new.example.com")
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	if err := manager.service.store.Save(Credentials{
		Relay: RelayCredentials{
			DeviceToken: "dev_live",
			NodeID:      "node_live",
			Endpoint:    "wss://relay-old.example.com/ws/connector",
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := manager.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	status := manager.Status()
	if status.Bound {
		t.Fatal("expected unbound status after relay base changed")
	}
	if status.PendingCode == "" {
		t.Fatal("expected pending code after relay base changed")
	}
	if !strings.Contains(status.LastError, "rebinding required") {
		t.Fatalf("last error = %q", status.LastError)
	}

	creds, err := manager.service.store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if creds.Relay.DeviceToken != "" || creds.Relay.Endpoint != "" || creds.Relay.NodeID != "" {
		t.Fatalf("expected cleared credentials after relay base changed, got %+v", creds.Relay)
	}
}

func TestIsPermanentRelayErrorDetectsHandshakeStatus(t *testing.T) {
	if !isPermanentRelayError(errors.New("relay websocket dial failed: 404 Not Found: websocket: bad handshake")) {
		t.Fatal("expected 404 handshake to be treated as permanent")
	}
	if !isPermanentRelayError(errors.New("relay websocket dial failed: 401 Unauthorized: websocket: bad handshake")) {
		t.Fatal("expected 401 handshake to be treated as permanent")
	}
	if isPermanentRelayError(errors.New("websocket: bad handshake")) {
		t.Fatal("plain bad handshake without status should not be treated as permanent")
	}
}

func TestLocalTargetURL(t *testing.T) {
	target, err := localTargetURL("http://127.0.0.1:7331", mustParseURL("/api/file?root=a"))
	if err != nil {
		t.Fatalf("localTargetURL() error = %v", err)
	}
	if target.String() != "http://127.0.0.1:7331/api/file?root=a" {
		t.Fatalf("localTargetURL() = %s", target.String())
	}
}

func mustParseURL(raw string) *url.URL {
	u, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	return u
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}
