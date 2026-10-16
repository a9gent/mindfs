// Package logthrottle collapses repeated log lines for the same failing
// condition, so one unhealthy dependency polled on a timer cannot flood the log.
package logthrottle

import (
	"log"
	"sync"
	"time"
)

// DefaultInterval is how long a single key stays silent after being emitted.
const DefaultInterval = 10 * time.Minute

type record struct {
	last       time.Time
	suppressed int
}

var (
	mu      sync.Mutex
	records = map[string]*record{}
)

// Printf logs at most once per interval per key. The emission after a quiet
// window reports how many duplicate lines it swallowed.
func Printf(key string, interval time.Duration, format string, args ...any) {
	if interval <= 0 {
		interval = DefaultInterval
	}
	now := time.Now()

	mu.Lock()
	rec := records[key]
	if rec == nil {
		rec = &record{last: now.Add(-interval - 1)}
		records[key] = rec
	}
	if now.Sub(rec.last) < interval {
		rec.suppressed++
		mu.Unlock()
		return
	}
	duplicates := rec.suppressed
	rec.last = now
	rec.suppressed = 0
	mu.Unlock()

	if duplicates > 0 {
		full := make([]any, 0, len(args)+1)
		full = append(full, args...)
		full = append(full, duplicates)
		log.Printf(format+" (suppressed %d duplicate lines)", full...)
		return
	}
	log.Printf(format, args...)
}

// Reset clears all keys; for tests only.
func Reset() {
	mu.Lock()
	defer mu.Unlock()
	records = map[string]*record{}
}
