package api

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// pairingClientIP uses the connection peer and never trusts forwarding headers.
func pairingClientIP(r *http.Request) string {
	host := strings.TrimSpace(r.RemoteAddr)
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		// Never use attacker-controlled headers as a fallback identity.
		return "unknown"
	}
	return peer.WithZone("").Unmap().String()
}
