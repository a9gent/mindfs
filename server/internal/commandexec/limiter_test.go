package commandexec

import (
	"bytes"
	"testing"
)

func TestByteRingKeepsTail(t *testing.T) {
	ring := NewByteRing(5)
	ring.Write([]byte("abc"))
	ring.Write([]byte("defg"))
	if got := string(ring.Bytes()); got != "cdefg" {
		t.Fatalf("tail = %q, want %q", got, "cdefg")
	}
}

func TestOutputLimiterFlushDoesNotRepeatSmallCycles(t *testing.T) {
	limiter := NewOutputLimiter()
	limiter.Write([]byte("one"))
	first, ok := limiter.Flush()
	if !ok || first.Text != "one" || first.SkippedBytes != 0 {
		t.Fatalf("first flush = %#v ok=%v", first, ok)
	}
	_, ok = limiter.Flush()
	if ok {
		t.Fatal("second flush unexpectedly had output")
	}
	limiter.Write([]byte("two"))
	second, ok := limiter.Flush()
	if !ok || second.Text != "two" || second.SkippedBytes != 0 {
		t.Fatalf("second data flush = %#v ok=%v", second, ok)
	}
}

func TestOutputLimiterUsesSingleFlushLimitForAllOutput(t *testing.T) {
	limiter := NewOutputLimiter()
	limiter.Write(bytes.Repeat([]byte("a"), DefaultFlushTailBytes+10))
	chunk, ok := limiter.Flush()
	if !ok {
		t.Fatal("expected flush output")
	}
	if len(chunk.Text) != DefaultFlushTailBytes {
		t.Fatalf("flush len = %d, want %d", len(chunk.Text), DefaultFlushTailBytes)
	}
	if chunk.SkippedBytes != 10 {
		t.Fatalf("skipped bytes = %d, want 10", chunk.SkippedBytes)
	}
}

func TestOutputLimiterTailBytesUsesRawRingLength(t *testing.T) {
	limiter := NewOutputLimiter()
	limiter.Write([]byte{0xff, 'o', 'k'})
	if got := limiter.TailBytes(); got != 3 {
		t.Fatalf("tail bytes = %d, want 3", got)
	}
}
