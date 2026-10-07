package api

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

const (
	pairingSourceInterval    = 6 * time.Second
	pairingSourceBurst       = 5
	pairingGlobalInterval    = time.Second
	pairingGlobalBurst       = 20
	pairingSourceMaxInFlight = 2
	pairingGlobalMaxInFlight = 16
	pairingFailureThreshold  = 3
	pairingInitialCooldown   = 5 * time.Second
	pairingMaxCooldown       = 30 * time.Minute
	// Nine doublings reach the cooldown cap, so further failures need no additional state.
	pairingMaxFailureCount = pairingFailureThreshold + 9
	pairingSourceTTL       = 24 * time.Hour
	pairingMaxSources      = 4096
	pairingRequestTimeout  = 10 * time.Second
)

// pairingBucket tracks consumed quota using the next token's arrival time.
// The burst allows borrowing future tokens; denied requests do not consume quota.
type pairingBucket struct {
	next time.Time
}

func (b *pairingBucket) wait(now time.Time, interval time.Duration, burst int) time.Duration {
	return max(0, b.next.Add(-time.Duration(burst-1)*interval).Sub(now))
}

func (b *pairingBucket) take(now time.Time, interval time.Duration) {
	if b.next.Before(now) {
		b.next = now
	}
	b.next = b.next.Add(interval)
}

type pairingSource struct {
	bucket       pairingBucket
	lastSeen     time.Time
	blockedUntil time.Time
	failures     int
	inFlight     int
}

// pairingLimiter is ready to use at its zero value and reclaims idle sources on admission.
// mu protects quota, in-flight counts, and cooldowns during both admission and completion.
type pairingLimiter struct {
	mu          sync.Mutex
	sources     map[string]*pairingSource
	global      pairingBucket
	inFlight    int
	nextCleanup time.Time
	now         func() time.Time
}

func (l *pairingLimiter) clock() time.Time {
	if l.now != nil {
		return l.now()
	}
	return time.Now()
}

// begin returns a completion callback for admitted attempts, or a retry delay.
// Call the callback exactly once, with true only after a successful handshake.
func (l *pairingLimiter) begin(clientIP string) (func(bool), time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	if l.sources == nil {
		l.sources = make(map[string]*pairingSource)
	}
	if !now.Before(l.nextCleanup) {
		for ip, source := range l.sources {
			if source.inFlight == 0 && now.Sub(source.lastSeen) >= pairingSourceTTL {
				delete(l.sources, ip)
			}
		}
		l.nextCleanup = now.Add(time.Minute)
	}

	source := l.sources[clientIP]
	delay := l.global.wait(now, pairingGlobalInterval, pairingGlobalBurst)
	if l.inFlight >= pairingGlobalMaxInFlight {
		delay = max(delay, time.Second)
	}
	if source != nil {
		source.lastSeen = now
		delay = max(
			delay,
			source.blockedUntil.Sub(now),
			source.bucket.wait(now, pairingSourceInterval, pairingSourceBurst),
		)
		if source.inFlight >= pairingSourceMaxInFlight {
			delay = max(delay, time.Second)
		}
	} else if len(l.sources) >= pairingMaxSources {
		// Reject new sources rather than evicting existing penalties when the table is full.
		delay = max(delay, time.Minute)
	}
	if delay > 0 {
		return nil, delay
	}
	if source == nil {
		source = &pairingSource{lastSeen: now}
		l.sources[clientIP] = source
	}
	source.bucket.take(now, pairingSourceInterval)
	l.global.take(now, pairingGlobalInterval)
	source.inFlight++
	l.inFlight++
	return func(success bool) {
		l.mu.Lock()
		defer l.mu.Unlock()
		source.inFlight--
		l.inFlight--
		source.lastSeen = l.clock()
		if success {
			source.failures = 0
			source.blockedUntil = time.Time{}
			return
		}
		source.failures = min(source.failures+1, pairingMaxFailureCount)
		if source.failures >= pairingFailureThreshold {
			backoffShift := uint(source.failures - pairingFailureThreshold)
			cooldown := min(pairingInitialCooldown<<backoffShift, pairingMaxCooldown)
			source.blockedUntil = source.lastSeen.Add(cooldown)
		}
	}, 0
}

func respondPairingRateLimit(w http.ResponseWriter, delay time.Duration) {
	seconds := max(1, int((delay+time.Second-1)/time.Second))
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	w.Header().Set("Cache-Control", "no-store")
	respondJSON(w, http.StatusTooManyRequests, map[string]any{
		"error":       "e2ee_rate_limited",
		"retry_after": seconds,
	})
}
