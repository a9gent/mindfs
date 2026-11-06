package api

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
	"mindfs/server/internal/preferences"
	"mindfs/server/internal/relay"
)

func TestRelayConnectionPreference(t *testing.T) {
	h, _ := newConfigTransferTestHandler(t)
	for _, test := range []struct {
		method, body string
		status       int
		mode         string
	}{
		{http.MethodGet, "", http.StatusOK, "auto"},
		{http.MethodPut, `{}`, http.StatusBadRequest, "auto"},
		{http.MethodPut, `{"mode":null}`, http.StatusBadRequest, "auto"},
		{http.MethodPut, `{"mode":"invalid"}`, http.StatusBadRequest, "auto"},
		{http.MethodPut, `{"mode":"direct"}`, http.StatusOK, "direct"},
		{http.MethodPut, `{"mode":"system"}`, http.StatusOK, "system"},
		{http.MethodPut, `{"mode":"auto"}`, http.StatusOK, "auto"},
		{http.MethodGet, "", http.StatusOK, "auto"},
	} {
		w := httptest.NewRecorder()
		h.handleRelayConnectionPreference(w, httptest.NewRequest(test.method, "/api/preferences/relay-connection", strings.NewReader(test.body)))
		if w.Code != test.status {
			t.Fatalf("%s %s: status=%d body=%s", test.method, test.body, w.Code, w.Body.String())
		}
		if w.Code == http.StatusOK {
			var response struct {
				Mode string `json:"mode"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if response.Mode != test.mode {
				t.Fatalf("response mode = %q, want %q", response.Mode, test.mode)
			}
		}
		reloaded, err := preferences.NewStore()
		if err != nil {
			t.Fatal(err)
		}
		if reloaded.RelayConnectionMode() != test.mode {
			t.Fatalf("persisted mode = %q, want %q", reloaded.RelayConnectionMode(), test.mode)
		}
	}
}

func TestRelayConnectionPreferenceResponseSurvivesReconnect(t *testing.T) {
	h, _ := newConfigTransferTestHandler(t)
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		h.handleRelayConnectionPreference(w, r)
	}))
	defer local.Close()
	connections := make(chan *yamux.Session, 8)
	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		session, err := yamux.Server(relay.NewWebSocketNetConn(conn), nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer session.Close()
		connections <- session
		<-session.CloseChan()
	}))
	defer upstream.Close()
	manager, err := relay.NewManager(strings.TrimPrefix(local.URL, "http://"), false, upstream.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	h.AppContext.Relay = manager
	store, err := relay.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Save(relay.Credentials{Relay: relay.RelayCredentials{
		DeviceToken: "test-token", NodeID: "node", Endpoint: "ws" + strings.TrimPrefix(upstream.URL, "http") + "/ws/connector",
	}}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := manager.Start(ctx); err != nil {
		t.Fatal(err)
	}
	waitConnection := func() *yamux.Session {
		t.Helper()
		select {
		case session := <-connections:
			return session
		case <-time.After(3 * time.Second):
			t.Fatal("relay did not connect")
			return nil
		}
	}
	session := waitConnection()
	for _, mode := range []string{"system", "direct", "auto"} {
		stream, err := session.OpenStream()
		if err != nil {
			t.Fatal(err)
		}
		stream.SetDeadline(time.Now().Add(3 * time.Second))
		req, err := http.NewRequest(http.MethodPut, "http://node/api/preferences/relay-connection", strings.NewReader(`{"mode":"`+mode+`"}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-MindFS-Relayed", "1")
		if err := req.Write(stream); err != nil {
			t.Fatal(err)
		}
		resp, err := http.ReadResponse(bufio.NewReader(stream), req)
		if err != nil {
			t.Fatalf("mode %s: response interrupted by reconnect: %v", mode, err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		stream.Close()
		if err != nil {
			t.Fatalf("mode %s: response body interrupted: %v", mode, err)
		}
		var result struct {
			Mode string `json:"mode"`
		}
		if err := json.Unmarshal(body, &result); err != nil {
			t.Fatalf("mode %s: invalid response %q: %v", mode, body, err)
		}
		if resp.StatusCode != http.StatusOK || result.Mode != mode {
			t.Fatalf("mode %s: status %d, response %s", mode, resp.StatusCode, body)
		}
		if resp.Header.Get(relay.ConnectionModeResponseHeader) != "" {
			t.Fatal("connector exposed its internal reconnect header")
		}
		session = waitConnection()
	}
}
