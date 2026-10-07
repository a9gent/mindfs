package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"mindfs/server/internal/e2ee"
)

func TestPairingLimitsSuccessfulAttemptsAndRefills(t *testing.T) {
	now := time.Now()
	l := pairingLimiter{now: func() time.Time { return now }}
	for i := 0; i < 5; i++ {
		finish, delay := l.begin("192.0.2.1")
		if finish == nil {
			t.Fatalf("attempt %d rejected: %s", i, delay)
		}
		finish(true)
	}
	if finish, delay := l.begin("192.0.2.1"); finish != nil || delay != 6*time.Second {
		t.Fatalf("burst overflow delay = %s, admitted = %v", delay, finish != nil)
	}
	finish, _ := l.begin("192.0.2.2")
	if finish == nil {
		t.Fatal("one source's limit blocked another source")
	}
	finish(true)
	now = now.Add(6 * time.Second)
	finish, _ = l.begin("192.0.2.1")
	if finish == nil {
		t.Fatal("source did not refill after six seconds")
	}
	finish(true)
}

func TestPairingGlobalLimitPreventsSourceRotation(t *testing.T) {
	now := time.Now()
	l := pairingLimiter{now: func() time.Time { return now }}
	for i := 0; i < 20; i++ {
		finish, _ := l.begin(fmt.Sprintf("192.0.2.%d", i))
		if finish == nil {
			t.Fatalf("attempt %d rejected before global burst", i)
		}
		finish(true)
	}
	if finish, delay := l.begin("198.51.100.1"); finish != nil || delay != time.Second {
		t.Fatalf("global overflow delay = %s, admitted = %v", delay, finish != nil)
	}
	if len(l.sources) != 20 {
		t.Fatal("globally rejected requests must not allocate source state")
	}
	now = now.Add(time.Second)
	finish, _ := l.begin("198.51.100.1")
	if finish == nil {
		t.Fatal("global bucket did not refill")
	}
	finish(true)
}

func TestPairingFailureCooldownAndRecovery(t *testing.T) {
	now := time.Now()
	l := pairingLimiter{now: func() time.Time { return now }}
	for i := 0; i < 2; i++ {
		finish, _ := l.begin("client")
		finish(false)
	}
	for _, expected := range []time.Duration{5, 10, 20, 40, 80, 160, 320, 640, 1280, 1800, 1800} {
		finish, delay := l.begin("client")
		if finish == nil {
			t.Fatalf("retry after cooldown rejected: %s", delay)
		}
		finish(false)
		finish, delay = l.begin("client")
		if finish != nil || delay != expected*time.Second {
			t.Fatalf("cooldown = %s, want %s; admitted = %v", delay, expected*time.Second, finish != nil)
		}
		// Rejected traffic must not prolong the lockout.
		now = now.Add(time.Second)
		_, remaining := l.begin("client")
		if remaining != delay-time.Second {
			t.Fatalf("rejection extended cooldown: %s", remaining)
		}
		now = now.Add(remaining)
	}
	finish, _ := l.begin("client")
	finish(true)
	finish, delay := l.begin("client")
	if finish == nil {
		t.Fatalf("successful pairing did not clear failures: %s", delay)
	}
	finish(false)
	finish, delay = l.begin("client")
	if finish == nil {
		t.Fatalf("single failure after recovery triggered cooldown: %s", delay)
	}
	finish(true)
}

func TestPairingConcurrentAttemptsAreBounded(t *testing.T) {
	for _, tt := range []struct {
		name string
		key  func(int) string
		want int
	}{
		{"same source", func(int) string { return "client" }, 2},
		{"different sources", func(i int) string { return strconv.Itoa(i) }, 16},
	} {
		t.Run(tt.name, func(t *testing.T) {
			assertPairingConcurrentLimit(t, tt.key, tt.want)
		})
	}
}

func assertPairingConcurrentLimit(t *testing.T, clientIP func(int) string, want int) {
	t.Helper()
	var limiter pairingLimiter
	var wg sync.WaitGroup
	admitted := make(chan func(bool), 64)
	for i := 0; i < cap(admitted); i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if finish, _ := limiter.begin(clientIP(i)); finish != nil {
				admitted <- finish
			}
		}(i)
	}
	wg.Wait()
	close(admitted)
	if len(admitted) != want {
		t.Fatalf("admitted %d concurrent requests, want %d", len(admitted), want)
	}
	for finish := range admitted {
		finish(true)
	}
	if limiter.inFlight != 0 {
		t.Fatalf("completion leaked in-flight slots: %d", limiter.inFlight)
	}
}

func TestPairingSourceStateIsBoundedAndExpires(t *testing.T) {
	now := time.Now()
	l := pairingLimiter{now: func() time.Time { return now }, sources: make(map[string]*pairingSource)}
	for i := 0; i < pairingMaxSources; i++ {
		l.sources[strconv.Itoa(i)] = &pairingSource{lastSeen: now, blockedUntil: now.Add(pairingMaxCooldown)}
	}
	if finish, delay := l.begin("new"); finish != nil || delay <= 0 || len(l.sources) != pairingMaxSources {
		t.Fatal("full table must reject new sources without evicting penalties")
	}
	now = now.Add(23 * time.Hour)
	if finish, _ := l.begin("new"); finish != nil || len(l.sources) != pairingMaxSources {
		t.Fatal("source records must remain until 24 idle hours")
	}
	now = now.Add(time.Hour)
	finish, _ := l.begin("new")
	if finish == nil || len(l.sources) != 1 {
		t.Fatal("expired sources were not reclaimed")
	}
	now = now.Add(pairingSourceTTL)
	other, _ := l.begin("other")
	if l.sources["new"] == nil {
		t.Fatal("cleanup removed an in-flight attempt")
	}
	finish(true)
	other(true)
}

func newPairingTestHandler() *HTTPHandler {
	manager := e2ee.NewManager(e2ee.Config{
		Enabled:       true,
		NodeID:        "node",
		PairingSecret: "pairing-secret",
	})
	return &HTTPHandler{AppContext: &AppContext{E2EE: manager}}
}

func pairingTestPayload(t *testing.T, clientID, secret string) []byte {
	t.Helper()
	_, pk, err := e2ee.GenerateECDHKeypair()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]string{
		"client_id":     clientID,
		"node_id":       "node",
		"client_eph_pk": pk,
		"client_nonce":  "test-nonce",
		"proof":         e2ee.BuildOpenProof(secret, "node", pk, "test-nonce"),
	})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestPairingEndpointRateLimitsBeforeReadingBody(t *testing.T) {
	h := newPairingTestHandler()
	now := time.Now()
	h.pairingLimiter.now = func() time.Time { return now }
	router := h.Routes()
	for i := 0; i < 3; i++ {
		payload := pairingTestPayload(t, strconv.Itoa(i), "wrong-secret")
		req := httptest.NewRequest(http.MethodPost, "/api/e2ee/open", bytes.NewReader(payload))
		req.RemoteAddr = fmt.Sprintf("192.0.2.1:%d", 1000+i)
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.100.%d", i))
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusForbidden {
			t.Fatalf("bad proof attempt %d: status %d", i, resp.Code)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/api/e2ee/open", nil)
	req.RemoteAddr = "192.0.2.1:9999"
	req.Body = io.NopCloser(unreadablePairingBody{})
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	if resp.Code != http.StatusTooManyRequests || resp.Header().Get("Retry-After") != "5" || resp.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("rate limited response: status=%d headers=%v", resp.Code, resp.Header())
	}
	var payload struct {
		Error      string `json:"error"`
		RetryAfter int    `json:"retry_after"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &payload); err != nil || payload.Error != "e2ee_rate_limited" || payload.RetryAfter != 5 {
		t.Fatalf("unexpected limit response %s: %v", resp.Body, err)
	}

	now = now.Add(5 * time.Second)
	req = httptest.NewRequest(http.MethodPost, "/api/e2ee/open", bytes.NewReader(pairingTestPayload(t, "paired", "pairing-secret")))
	req.RemoteAddr = "192.0.2.1:9999"
	resp = httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("valid pairing after cooldown failed: %d %s", resp.Code, resp.Body)
	}
	if _, err := h.AppContext.E2EE.SessionForClient("paired"); err != nil {
		t.Fatalf("successful pairing did not create a session: %v", err)
	}
}

type unreadablePairingBody struct{}

func (unreadablePairingBody) Read([]byte) (int, error) {
	panic("rate-limited request body must not be read")
}

func TestPairingFailuresIncludeMalformedPayloads(t *testing.T) {
	h := newPairingTestHandler()
	router := h.Routes()
	for _, body := range []string{"not json", `{}`, `{"client_id":"x"}`} {
		req := httptest.NewRequest(http.MethodPost, "/api/e2ee/open", strings.NewReader(body))
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusBadRequest {
			t.Fatalf("malformed request status = %d", resp.Code)
		}
	}
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, httptest.NewRequest(http.MethodPost, "/api/e2ee/open", strings.NewReader(`{}`)))
	if resp.Code != http.StatusTooManyRequests {
		t.Fatalf("malformed requests bypassed cooldown: %d", resp.Code)
	}
}

func TestPairingCooldownDoesNotBlockAuthenticatedAPI(t *testing.T) {
	h := newPairingTestHandler()
	key := bytes.Repeat([]byte{1}, 32)
	if _, err := h.AppContext.E2EE.OpenSessionForClient("paired", e2ee.DerivedKey{Transport: key}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		finish, _ := h.pairingLimiter.begin("192.0.2.1")
		finish(false)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/protected", nil)
	req.RemoteAddr = "192.0.2.1:1234"
	ts := time.Now().UTC().Format(time.RFC3339)
	req.Header.Set(e2eeHeaderName, "1")
	req.Header.Set(clientIDHeaderName, "paired")
	req.Header.Set(e2eeTSHeaderName, ts)
	req.Header.Set(e2eeProofHeaderName, e2ee.BuildRequestProof(key, req.Method, req.URL.Path, ts, "paired"))
	resp := httptest.NewRecorder()
	h.protectedEndpoint(func(w http.ResponseWriter, r *http.Request) {
		respondJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})(resp, req)
	if resp.Code != http.StatusOK || resp.Header().Get(e2eeHeaderName) != "1" {
		t.Fatalf("paired API request failed during cooldown: %d %s", resp.Code, resp.Body)
	}
}

func TestPairingReadDeadlinePassesThroughLoggingMiddleware(t *testing.T) {
	h := newPairingTestHandler()
	resp := &pairingDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	LoggingMiddleware(h.Routes()).ServeHTTP(resp, httptest.NewRequest(http.MethodPost, "/api/e2ee/open", strings.NewReader(`{}`)))
	if len(resp.deadlines) != 1 || resp.deadlines[0].IsZero() {
		t.Fatalf("read deadline must remain set for post-handler body draining: %v", resp.deadlines)
	}
}

type pairingDeadlineRecorder struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (r *pairingDeadlineRecorder) SetReadDeadline(deadline time.Time) error {
	r.deadlines = append(r.deadlines, deadline)
	return nil
}

// Use real TCP connections: ResponseRecorder does not perform net/http's
// post-handler body drain and cannot catch a prematurely cleared deadline.
func TestPairingSlowBodyDeadline(t *testing.T) {
	for _, tt := range []struct {
		name              string
		body              string
		completedAttempts int
		status            int
	}{
		{"incomplete JSON", `{"`, 0, http.StatusBadRequest},
		{"trailing body", `{}`, 0, http.StatusBadRequest},
		{"rate limited body", ``, pairingSourceBurst, http.StatusTooManyRequests},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			h := newPairingTestHandler()
			for i := 0; i < tt.completedAttempts; i++ {
				finish, _ := h.pairingLimiter.begin("127.0.0.1")
				finish(true)
			}
			srv := httptest.NewServer(LoggingMiddleware(h.Routes()))
			defer srv.Close()
			conn, err := net.Dial("tcp", srv.Listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if err := conn.SetDeadline(time.Now().Add(pairingRequestTimeout + 3*time.Second)); err != nil {
				t.Fatal(err)
			}
			if _, err := fmt.Fprintf(conn, "POST /api/e2ee/open HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n%s", tt.body); err != nil {
				t.Fatal(err)
			}
			resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatalf("slow request did not receive a bounded response: %v", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tt.status {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.status)
			}
			if !resp.Close {
				t.Fatal("incomplete body must close the connection after responding")
			}
		})
	}
}

func TestPairingDeadlineDoesNotAffectNextRequest(t *testing.T) {
	t.Parallel()
	h := newPairingTestHandler()
	mux := http.NewServeMux()
	mux.Handle("/", h.Routes())
	mux.HandleFunc("/body", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_, _ = w.Write(body)
	})
	srv := httptest.NewServer(LoggingMiddleware(mux))
	defer srv.Close()
	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(pairingRequestTimeout + 5*time.Second)); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	if _, err := fmt.Fprint(conn, "POST /api/e2ee/open HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}"); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || resp.Close {
		t.Fatal("complete pairing body should preserve keep-alive")
	}
	if _, err := fmt.Fprint(conn, "POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(pairingRequestTimeout + 100*time.Millisecond)
	if _, err := fmt.Fprint(conn, "}"); err != nil {
		t.Fatal(err)
	}
	resp, err = http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != http.StatusOK || string(body) != "{}" {
		t.Fatalf("next request inherited pairing deadline: status=%d body=%q err=%v", resp.StatusCode, body, err)
	}
}
