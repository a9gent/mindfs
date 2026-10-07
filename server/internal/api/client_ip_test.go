package api

import (
	"net/http/httptest"
	"testing"
)

func TestPairingClientIPUsesConnectionPeer(t *testing.T) {
	for _, tt := range []struct {
		name, remote, forwarded, want string
	}{
		{"direct ignores forged header", "192.0.2.1:1234", "198.51.100.9", "192.0.2.1"},
		{"loopback ignores forwarded client", "127.0.0.1:1234", "192.0.2.1", "127.0.0.1"},
		{"IPv6 loopback ignores chain", "[::1]:1234", "192.0.2.1, 10.0.0.5", "::1"},
		{"missing header", "127.0.0.1:1234", "", "127.0.0.1"},
		{"IPv4 mapped peer", "[::ffff:192.0.2.1]:1234", "198.51.100.9", "192.0.2.1"},
		{"canonical IPv6", "[2001:0db8:0:0::1]:1234", "", "2001:db8::1"},
		{"invalid peer", "not-an-ip", "192.0.2.1", "unknown"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/e2ee/open", nil)
			req.RemoteAddr = tt.remote
			req.Header.Set("X-Forwarded-For", tt.forwarded)
			req.Header.Set("X-Real-IP", "203.0.113.9")
			if got := pairingClientIP(req); got != tt.want {
				t.Fatalf("client IP = %q, want %q", got, tt.want)
			}
		})
	}
	req := httptest.NewRequest("POST", "/api/e2ee/open", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Add("X-Forwarded-For", "198.51.100.9")
	req.Header.Add("X-Forwarded-For", "192.0.2.1")
	if got := pairingClientIP(req); got != "127.0.0.1" {
		t.Fatalf("multiple headers: client IP = %q", got)
	}
}
