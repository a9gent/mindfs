package relay

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"mindfs/server/internal/testutil"
)

func TestRelayNetworkProxy(t *testing.T) {
	// ProxyFromEnvironment caches its environment. Run this test in a fresh
	// process so unrelated tests and the developer's proxy do not affect it.
	if os.Getenv("MINDFS_TEST_RELAY_PROXY") != "1" {
		cmd := exec.Command(os.Args[0], "-test.run=^TestRelayNetworkProxy$")
		cmd.Env = append(os.Environ(), "MINDFS_TEST_RELAY_PROXY=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("proxy test: %v\n%s", err, output)
		}
		return
	}
	var targetAddr string
	var proxyRequests atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyRequests.Add(1)
		if r.URL.Path == "/proxy-failure" {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if strings.HasPrefix(r.Host, "auto-relay.invalid") {
			if r.Method != http.MethodConnect {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			upstream, err := net.Dial("tcp", targetAddr)
			if err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			defer upstream.Close()
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			defer conn.Close()
			io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
			go func() { io.Copy(upstream, conn); upstream.Close() }()
			io.Copy(conn, upstream)
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "bypass.invalid")
	t.Setenv("no_proxy", "")
	t.Setenv("REQUEST_METHOD", "")
	upgrader := websocket.Upgrader{}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/unauthorized" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if websocket.IsWebSocketUpgrade(r) {
			conn, err := upgrader.Upgrade(w, r, nil)
			if err == nil {
				conn.Close()
			}
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	targetAddr = strings.TrimPrefix(target.URL, "http://")
	var directAttempts atomic.Int32
	var failDirect atomic.Bool
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		if addr == "bypass.invalid:80" {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
		}
		if addr == "auto-relay.invalid:80" {
			directAttempts.Add(1)
			if failDirect.Load() {
				return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
			}
			addr = targetAddr
		}
		if addr == "relay.invalid:80" {
			addr = strings.TrimPrefix(target.URL, "http://")
		}
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, network, addr)
	}
	network := &relayNetwork{}
	transport := network.transport()
	transport.direct.DialContext = dial
	transport.autoDirect.DialContext = dial
	transport.system.DialContext = dial
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	dialer := websocket.Dialer{NetDialContext: dial, HandshakeTimeout: 3 * time.Second}
	for _, direct := range []bool{true, false, true} {
		network.state.Store(networkSystem)
		if direct {
			network.state.Store(networkDirect)
		}
		resp, err := client.Get("http://relay.invalid/")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		want := http.StatusBadGateway
		if direct {
			want = http.StatusNoContent
		}
		if resp.StatusCode != want {
			t.Fatalf("HTTP direct=%v: status %d, want %d", direct, resp.StatusCode, want)
		}
		conn, resp, err := network.dialWebSocket(context.Background(), "ws://relay.invalid/", nil, dialer)
		if conn != nil {
			conn.Close()
		}
		if resp != nil {
			resp.Body.Close()
		}
		if (err == nil) != direct {
			t.Fatalf("WebSocket direct=%v: %v", direct, err)
		}
	}
	for _, protocol := range []string{"http", "ws"} {
		t.Run(protocol, func(t *testing.T) {
			network.state.Store(networkAuto)
			failDirect.Store(false)
			transport.CloseIdleConnections()
			before := proxyRequests.Load()
			request := func(path string, wantSuccess bool) {
				t.Helper()
				if protocol == "http" {
					resp, err := client.Get("http://auto-relay.invalid" + path)
					if err != nil {
						t.Fatal(err)
					}
					defer resp.Body.Close()
					want := http.StatusNoContent
					if !wantSuccess {
						want = http.StatusUnauthorized
					}
					if resp.StatusCode != want {
						t.Fatalf("status = %d, want %d", resp.StatusCode, want)
					}
				} else {
					conn, resp, err := network.dialWebSocket(context.Background(), "ws://auto-relay.invalid"+path, nil, dialer)
					if conn != nil {
						conn.Close()
					}
					if resp != nil {
						resp.Body.Close()
					}
					if (err == nil) != wantSuccess {
						t.Fatalf("websocket success=%v: %v", wantSuccess, err)
					}
				}
			}
			request("/", true)
			request("/unauthorized", false)
			if proxyRequests.Load() != before || network.state.Load() != networkAuto {
				t.Fatal("healthy direct connection or HTTP 401 triggered proxy fallback")
			}
			failDirect.Store(true)
			transport.CloseIdleConnections()
			request("/", true)
			if network.state.Load() != networkAutoProxy {
				t.Fatal("successful proxy fallback was not remembered")
			}
			attempts := directAttempts.Load()
			request("/", true)
			if directAttempts.Load() != attempts {
				t.Fatal("retried direct after successful proxy fallback")
			}
		})
	}
	network.state.Store(networkAuto)
	failDirect.Store(true)
	transport.CloseIdleConnections()
	resp, err := client.Get("http://auto-relay.invalid/proxy-failure")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || network.state.Load() != networkAuto {
		t.Fatal("failed proxy was remembered as working")
	}
	before := proxyRequests.Load()
	if resp, err := client.Get("http://bypass.invalid/"); err == nil {
		resp.Body.Close()
		t.Fatal("NO_PROXY request unexpectedly succeeded")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://auto-relay.invalid/", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp, err := client.Do(req); err == nil {
		resp.Body.Close()
		t.Fatal("cancelled request unexpectedly succeeded")
	}
	if proxyRequests.Load() != before {
		t.Fatal("NO_PROXY or cancellation triggered proxy request")
	}
}

func TestSetConnectionModeReconnectsRelay(t *testing.T) {
	testutil.IsolateUserDirs(t, t.TempDir())
	connections := make(chan struct{}, 4)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		connections <- struct{}{}
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	manager, err := NewManager(":7331", false, server.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	manager.service.localClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
	})}
	creds := Credentials{Relay: RelayCredentials{DeviceToken: "test-token", NodeID: "node", Endpoint: "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/connector"}}
	if err := manager.service.store.Save(creds); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := manager.Start(ctx); err != nil {
		t.Fatal(err)
	}
	wait := func() {
		t.Helper()
		select {
		case <-connections:
		case <-time.After(3 * time.Second):
			t.Fatal("relay did not connect")
		}
	}
	wait()
	manager.SetConnectionMode("system")
	wait()
	manager.SetConnectionMode("direct")
	wait()
	manager.SetConnectionMode("auto")
	wait()
	stored, err := manager.service.store.Load()
	if err != nil || stored.Relay.DeviceToken != "test-token" {
		t.Fatalf("binding changed after reconnect: %+v, %v", stored, err)
	}
}
