package api

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// ParseTrustedProxies parses comma-separated proxy IPs/CIDRs and normalizes IPv4-mapped addresses.
// An empty list trusts no forwarding headers, including those supplied by loopback peers.
func ParseTrustedProxies(value string) ([]netip.Prefix, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	var prefixes []netip.Prefix
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if addr, err := netip.ParseAddr(item); err == nil && addr.Zone() == "" {
			addr = addr.Unmap()
			prefixes = append(prefixes, netip.PrefixFrom(addr, addr.BitLen()))
			continue
		}
		prefix, err := netip.ParsePrefix(item)
		if err != nil {
			return nil, fmt.Errorf("invalid trusted proxy %q: expected an IP address or CIDR", item)
		}
		if prefix.Addr().Is4In6() {
			if prefix.Bits() < 96 {
				return nil, fmt.Errorf("invalid trusted proxy %q: IPv4-mapped CIDR must have at least 96 prefix bits", item)
			}
			prefix = netip.PrefixFrom(prefix.Addr().Unmap(), prefix.Bits()-96)
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

func pairingClientIP(r *http.Request, trusted []netip.Prefix) string {
	host := strings.TrimSpace(r.RemoteAddr)
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		// Never use attacker-controlled headers as a fallback identity.
		return "unknown"
	}
	peer = peer.WithZone("").Unmap()
	if !isTrustedProxy(peer, trusted) {
		return peer.String()
	}
	forwarded := strings.Join(r.Header.Values("X-Forwarded-For"), ",")
	if forwarded == "" || len(forwarded) > 4096 {
		return peer.String()
	}
	hops := strings.Split(forwarded, ",")
	if len(hops) > 32 {
		return peer.String()
	}
	// Walk from the verified peer towards the client, stopping at the first untrusted
	// hop so forged entries on the left cannot override the source identity.
	client := peer
	for i := len(hops) - 1; i >= 0; i-- {
		if !isTrustedProxy(client, trusted) {
			break
		}
		next, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil || next.Zone() != "" {
			return peer.String()
		}
		client = next.Unmap()
	}
	return client.String()
}

func isTrustedProxy(addr netip.Addr, trusted []netip.Prefix) bool {
	for _, prefix := range trusted {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}
