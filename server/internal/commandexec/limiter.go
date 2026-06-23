package commandexec

import (
	"time"
	"unicode/utf8"
)

const (
	DefaultPersistTailBytes = 64 * 1024
	DefaultFlushTailBytes   = 16 * 1024
	DefaultFlushEvery       = 128 * time.Millisecond
)

type OutputChunk struct {
	Text         string
	SkippedBytes int64
}

type OutputLimiter struct {
	totalBytes int64
	cycleBytes int64

	tailRing  *ByteRing
	flushTail *ByteRing
}

func NewOutputLimiter() *OutputLimiter {
	return &OutputLimiter{
		tailRing:  NewByteRing(DefaultPersistTailBytes),
		flushTail: NewByteRing(DefaultFlushTailBytes),
	}
}

func (l *OutputLimiter) Write(p []byte) {
	if l == nil || len(p) == 0 {
		return
	}
	l.totalBytes += int64(len(p))
	l.cycleBytes += int64(len(p))
	l.tailRing.Write(p)
	l.flushTail.Write(p)
}

func (l *OutputLimiter) Flush() (OutputChunk, bool) {
	if l == nil || l.cycleBytes == 0 {
		return OutputChunk{}, false
	}
	textBytes := l.flushTail.Bytes()
	skipped := l.cycleBytes - int64(len(textBytes))
	chunk := OutputChunk{
		Text:         string(validUTF8Tail(textBytes)),
		SkippedBytes: skipped,
	}
	l.flushTail.Reset()
	l.cycleBytes = 0
	return chunk, chunk.Text != "" || skipped > 0
}

func (l *OutputLimiter) Tail() []byte {
	if l == nil {
		return nil
	}
	return validUTF8Tail(l.tailRing.Bytes())
}

func (l *OutputLimiter) TailBytes() int64 {
	if l == nil {
		return 0
	}
	return int64(len(l.tailRing.Bytes()))
}

func (l *OutputLimiter) TotalBytes() int64 {
	if l == nil {
		return 0
	}
	return l.totalBytes
}

func (l *OutputLimiter) FlushEvery() time.Duration {
	return DefaultFlushEvery
}

func validUTF8Tail(p []byte) []byte {
	if len(p) == 0 || utf8.Valid(p) {
		return p
	}
	for len(p) > 0 && !utf8.Valid(p) {
		_, size := utf8.DecodeRune(p)
		if size <= 0 || size > len(p) {
			return nil
		}
		p = p[size:]
	}
	return p
}
