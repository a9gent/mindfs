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

	"mindfs/server/internal/testutil"
)

func TestGetOrCreateDeviceIDStable(t *testing.T) {
	configRoot := t.TempDir()
	testutil.IsolateUserDirs(t, configRoot)

	first, err := getOrCreateDeviceID()
	if err != nil {
		t.Fatalf("getOrCreateDeviceID() first error = %v", err)
	}
	if first == "" || !strings.HasPrefix(first, "md_") {
		t.Fatalf("unexpected device id = %q", first)
	}

	second, err := getOrCreateDeviceID()
	if err != nil {
		t.Fatalf("getOrCreateDeviceID() second error = %v", err)
	}
	if second != first {
		t.Fatalf("device id changed: first=%q second=%q", first, second)
	}
}

func TestCredentialsStoreSaveLoad(t *testing.T) {
	configRoot := t.TempDir()
	testutil.IsolateUserDirs(t, configRoot)

	store, err := NewCredentialsStore()
	if err != nil {
		t.Fatalf("NewCredentialsStore() error = %v", err)
	}

	input := Credentials{
		Relay: RelayCredentials{
			DeviceToken: "dev_123",
			NodeID:      "node_123",
			NodeName:    "Office Mac",
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

	info, err := os.Stat(store.filePath)
	if err != nil {
		t.Fatalf("credentials file missing: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials file mode = %o, want 0600", info.Mode().Perm())
	}
}

func TestCredentialsStoreClear(t *testing.T) {
	configRoot := t.TempDir()
	testutil.IsolateUserDirs(t, configRoot)

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

func TestPrepareLocalProxyHeadersRemovesRelayInternalHeaders(t *testing.T) {
	original, err := http.NewRequest(http.MethodGet, "https://test-node-relay.a9gent.com/", nil)
	if err != nil {
		t.Fatal(err)
	}
	original.Host = "test-node-relay.a9gent.com"
	original.Header.Set("X-MindFS-Relayed", "1")
	original.Header.Set("X-MindFS-Relay-Service-Slug", "test")
	targetURL, err := url.Parse("http://127.0.0.1:5173/")
	if err != nil {
		t.Fatal(err)
	}
	outbound := original.Clone(original.Context())

	prepareLocalProxyHeaders(outbound, original, targetURL, true)

	if got := outbound.Header.Get("X-MindFS-Relayed"); got != "" {
		t.Fatalf("X-MindFS-Relayed = %q, want empty", got)
	}
	if got := outbound.Header.Get("X-MindFS-Relay-Service-Slug"); got != "" {
		t.Fatalf("X-MindFS-Relay-Service-Slug = %q, want empty", got)
	}
	if got := outbound.Header.Get("X-Forwarded-Host"); got != "test-node-relay.a9gent.com" {
		t.Fatalf("X-Forwarded-Host = %q", got)
	}
}

func TestPrepareLocalProxyHeadersKeepsRelayedHeaderForNodeProxy(t *testing.T) {
	original, err := http.NewRequest(http.MethodGet, "https://relay.a9gent.com/n/node/", nil)
	if err != nil {
		t.Fatal(err)
	}
	original.Host = "relay.a9gent.com"
	original.Header.Set("X-MindFS-Relayed", "1")
	targetURL, err := url.Parse("http://127.0.0.1:7331/")
	if err != nil {
		t.Fatal(err)
	}
	outbound := original.Clone(original.Context())

	prepareLocalProxyHeaders(outbound, original, targetURL, false)

	if got := outbound.Header.Get("X-MindFS-Relayed"); got != "1" {
		t.Fatalf("X-MindFS-Relayed = %q, want 1", got)
	}
	if got := outbound.Header.Get("X-Forwarded-Host"); got != "relay.a9gent.com" {
		t.Fatalf("X-Forwarded-Host = %q", got)
	}
}

func TestServicePollBind(t *testing.T) {
	configRoot := t.TempDir()
	testutil.IsolateUserDirs(t, configRoot)

	svc, err := NewService(":7331", false)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	svc.client = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.String() != "https://relay.example.com/api/bind/poll?code=pc_live" {
				t.Fatalf("unexpected poll URL: %s", req.URL.String())
			}
			if strings.TrimSpace(req.Header.Get(relayDeviceIDHeader)) == "" {
				t.Fatal("expected device id header on bind poll request")
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Status:     "200 OK",
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"status":"confirmed","device_token":"dev_live","node_id":"node_live","node_name":"Office Mac","endpoint":"wss://relay.example.com/ws/connector"}`)),
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
	if result.Credentials.NodeName != "Office Mac" {
		t.Fatalf("node name = %q", result.Credentials.NodeName)
	}
}

func TestServiceStoreRelayNodeNameFromHandshake(t *testing.T) {
	configRoot := t.TempDir()
	testutil.IsolateUserDirs(t, configRoot)

	svc, err := NewService(":7331", false)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	creds := RelayCredentials{
		DeviceToken: "dev_live",
		NodeID:      "node_live",
		Endpoint:    "wss://relay.example.com/ws/connector",
	}
	resp := &http.Response{Header: http.Header{}}
	resp.Header.Set(relayNodeNameHeader, "Renamed Mac")

	svc.storeRelayNodeName(creds, resp)

	got, err := svc.store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got.Relay.NodeName != "Renamed Mac" {
		t.Fatalf("node name = %q", got.Relay.NodeName)
	}
}

func TestManagerStartBindingGeneratesPendingCode(t *testing.T) {
	configRoot := t.TempDir()
	testutil.IsolateUserDirs(t, configRoot)

	manager, err := NewManager(":7331", false, "https://relay.example.com", false)
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
		t.Fatalf("start should not generate pending code, got %q", status.PendingCode)
	}
	status, err = manager.StartBinding()
	if err != nil {
		t.Fatalf("StartBinding() error = %v", err)
	}
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
	testutil.IsolateUserDirs(t, configRoot)

	manager, err := NewManager(":7331", true, "https://relay.example.com", false)
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
	testutil.IsolateUserDirs(t, configRoot)

	manager, err := NewManager(":7331", false, "https://relay.example.com", false)
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
					Body:       io.NopCloser(strings.NewReader(`{"status":"confirmed","device_token":"dev_live","node_id":"node_live","node_name":"Office Mac","endpoint":"wss://relay.example.com/ws/connector"}`)),
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
	if _, err := manager.StartBinding(); err != nil {
		t.Fatalf("StartBinding() error = %v", err)
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
				if creds.Relay.NodeName != "Office Mac" {
					t.Fatalf("node name = %q", creds.Relay.NodeName)
				}
				return
			}
		case <-timeout:
			t.Fatal("relay did not start after confirmed poll")
		}
	}
}

func TestManagerPollTerminalBindStatusStopsPolling(t *testing.T) {
	configRoot := t.TempDir()
	testutil.IsolateUserDirs(t, configRoot)

	manager, err := NewManager(":7331", false, "https://relay.example.com", false)
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
	if _, err := manager.StartBinding(); err != nil {
		t.Fatalf("StartBinding() error = %v", err)
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
				return
			}
			t.Fatalf("expected pending code to clear after expired status, got first=%q current=%q", firstPendingCode, status.PendingCode)
		case <-timeout:
			t.Fatal("pending code did not clear after expired bind status")
		}
	}
}

func TestManagerDefaultsRelayBaseToLocalhost(t *testing.T) {
	configRoot := t.TempDir()
	testutil.IsolateUserDirs(t, configRoot)

	manager, err := NewManager(":7331", false, "", false)
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
	if status.PendingCode != "" {
		t.Fatalf("expected no pending code before explicit bind start, got %q", status.PendingCode)
	}
}

func TestManagerPermanentRelayErrorClearsCredentialsAndWaitsForExplicitRebind(t *testing.T) {
	configRoot := t.TempDir()
	testutil.IsolateUserDirs(t, configRoot)

	manager, err := NewManager(":7331", false, "https://relay.example.com", false)
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
			default:
				return nil, nil
			}
		}),
	}

	manager.handlePermanentRelayError(&relayDialError{
		statusCode: http.StatusUnauthorized,
		status:     "401 Unauthorized",
		errorCode:  "device_token_invalid",
		err:        errors.New("websocket: bad handshake"),
	})

	status := manager.Status()
	if status.Bound {
		t.Fatal("expected unbound status after permanent relay error")
	}
	if status.PendingCode != "" {
		t.Fatalf("expected no pending code before explicit rebind, got %q", status.PendingCode)
	}
	if !strings.Contains(status.LastError, "device_token_invalid") {
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
	testutil.IsolateUserDirs(t, configRoot)

	manager, err := NewManager(":7331", false, "https://relay-new.example.com", false)
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
	if status.PendingCode != "" {
		t.Fatalf("expected no pending code before explicit bind start, got %q", status.PendingCode)
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
	if !isPermanentRelayError(&relayDialError{
		statusCode: http.StatusUnauthorized,
		status:     "401 Unauthorized",
		errorCode:  "device_token_invalid",
		err:        errors.New("websocket: bad handshake"),
	}) {
		t.Fatal("expected device_token_invalid to be treated as permanent")
	}
	if isPermanentRelayError(&relayDialError{
		statusCode: http.StatusUnauthorized,
		status:     "401 Unauthorized",
		errorCode:  "device_token_required",
		err:        errors.New("websocket: bad handshake"),
	}) {
		t.Fatal("device_token_required should not be treated as permanent")
	}
	if isPermanentRelayError(&relayDialError{
		statusCode: http.StatusNotFound,
		status:     "404 Not Found",
		errorCode:  "not_found",
		err:        errors.New("websocket: bad handshake"),
	}) {
		t.Fatal("404 handshake should not be treated as permanent")
	}
	if isPermanentRelayError(errors.New("websocket: bad handshake")) {
		t.Fatal("plain bad handshake without status should not be treated as permanent")
	}
}

func TestNewRelayDialErrorReadsErrorCode(t *testing.T) {
	err := newRelayDialError(&http.Response{
		StatusCode: http.StatusUnauthorized,
		Status:     "401 Unauthorized",
		Body:       io.NopCloser(strings.NewReader(`{"error":"device_token_invalid"}`)),
	}, errors.New("websocket: bad handshake"))

	if !isPermanentRelayError(err) {
		t.Fatalf("expected parsed device_token_invalid to be permanent, got %v", err)
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
