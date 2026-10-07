package api

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPairingClientIPTrustBoundary(t *testing.T) {
	trusted, err := ParseTrustedProxies("127.0.0.1, ::1/128, 10.0.0.0/24")
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name, remote, forwarded, want string
	}{
		{"direct ignores forged header", "192.0.2.1:1234", "198.51.100.9", "192.0.2.1"},
		{"trusted proxy", "127.0.0.1:1234", "192.0.2.1", "192.0.2.1"},
		{"trusted chain", "[::1]:1234", "192.0.2.1, 10.0.0.5", "192.0.2.1"},
		{"forged first hop", "127.0.0.1:1234", "198.51.100.9, 192.0.2.1", "192.0.2.1"},
		{"ignore malformed untrusted prefix", "127.0.0.1:1234", "forged, 192.0.2.1", "192.0.2.1"},
		{"malformed nearest hop", "127.0.0.1:1234", "192.0.2.1, unknown", "127.0.0.1"},
		{"empty nearest hop", "127.0.0.1:1234", "192.0.2.1,", "127.0.0.1"},
		{"missing header", "127.0.0.1:1234", "", "127.0.0.1"},
		{"IPv4 mapped peer", "[::ffff:192.0.2.1]:1234", "198.51.100.9", "192.0.2.1"},
		{"IPv4 mapped client", "127.0.0.1:1234", "::ffff:192.0.2.1", "192.0.2.1"},
		{"canonical IPv6", "[2001:0db8:0:0::1]:1234", "", "2001:db8::1"},
		{"invalid peer", "not-an-ip", "192.0.2.1", "unknown"},
		{"oversized chain", "127.0.0.1:1234", strings.Repeat("10.0.0.5,", 32) + "10.0.0.5", "127.0.0.1"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/e2ee/open", nil)
			req.RemoteAddr = tt.remote
			req.Header.Set("X-Forwarded-For", tt.forwarded)
			req.Header.Set("X-Real-IP", "203.0.113.9")
			if got := pairingClientIP(req, trusted); got != tt.want {
				t.Fatalf("client IP = %q, want %q", got, tt.want)
			}
		})
	}
	req := httptest.NewRequest("POST", "/api/e2ee/open", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Add("X-Forwarded-For", "198.51.100.9")
	req.Header.Add("X-Forwarded-For", "192.0.2.1")
	if got := pairingClientIP(req, trusted); got != "192.0.2.1" {
		t.Fatalf("multiple headers: client IP = %q", got)
	}
	if got := pairingClientIP(req, nil); got != "127.0.0.1" {
		t.Fatalf("default must not trust loopback forwarding: client IP = %q", got)
	}
}

func TestParseTrustedProxiesRejectsInvalidConfiguration(t *testing.T) {
	for _, value := range []string{"*", "localhost", "127.0.0.1,", "10.0.0.0/33", "127.0.0.1:9000", "fe80::1%eth0", "::ffff:192.0.2.1/80"} {
		if _, err := ParseTrustedProxies(value); err == nil {
			t.Errorf("accepted invalid allowlist %q", value)
		}
	}
	trusted, err := ParseTrustedProxies("::ffff:192.0.2.1/120")
	if err != nil || len(trusted) != 1 || trusted[0].String() != "192.0.2.0/24" {
		t.Fatalf("IPv4-mapped CIDR = %v, %v", trusted, err)
	}
}
