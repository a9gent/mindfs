package logthrottle

import (
	"sync"
	"testing"
	"time"
)

func TestPrintfCollapsesRepeatedKeys(t *testing.T) {
	Reset()
	defer Reset()

	interval := time.Hour
	Printf("k", interval, "first")
	Printf("k", interval, "repeat")
	Printf("k", interval, "repeat")

	mu.Lock()
	defer mu.Unlock()
	rec := records["k"]
	if rec == nil {
		t.Fatal("expected record for key")
	}
	if rec.suppressed != 2 {
		t.Fatalf("suppressed = %d, want 2", rec.suppressed)
	}
}

func TestPrintfSeparateKeysAreIndependent(t *testing.T) {
	Reset()
	defer Reset()

	Printf("a", time.Hour, "a")
	Printf("b", time.Hour, "b")

	mu.Lock()
	defer mu.Unlock()
	if len(records) != 2 {
		t.Fatalf("records = %d, want 2", len(records))
	}
}

func TestPrintfEmitsAgainAfterInterval(t *testing.T) {
	Reset()
	defer Reset()

	Printf("k", 0, "one")
	// interval <= 0 falls back to DefaultInterval, so drive the clock by hand.
	mu.Lock()
	records["k"].last = time.Now().Add(-DefaultInterval - time.Second)
	records["k"].suppressed = 3
	mu.Unlock()
	Printf("k", 0, "two")

	mu.Lock()
	defer mu.Unlock()
	if records["k"].suppressed != 0 {
		t.Fatalf("suppressed = %d, want 0 after re-emission", records["k"].suppressed)
	}
}

func TestPrintfConcurrent(t *testing.T) {
	Reset()
	defer Reset()

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			Printf("key", time.Hour, "line %d", i)
		}(i)
	}
	wg.Wait()
}
