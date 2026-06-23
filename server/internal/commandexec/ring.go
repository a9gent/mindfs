package commandexec

type ByteRing struct {
	buf  []byte
	pos  int
	full bool
}

func NewByteRing(size int) *ByteRing {
	if size <= 0 {
		size = 1
	}
	return &ByteRing{buf: make([]byte, size)}
}

func (r *ByteRing) Write(p []byte) {
	if r == nil || len(p) == 0 {
		return
	}
	if len(p) >= len(r.buf) {
		copy(r.buf, p[len(p)-len(r.buf):])
		r.pos = 0
		r.full = true
		return
	}
	n := copy(r.buf[r.pos:], p)
	if n < len(p) {
		copy(r.buf, p[n:])
		r.full = true
	}
	r.pos = (r.pos + len(p)) % len(r.buf)
	if r.pos == 0 {
		r.full = true
	}
}

func (r *ByteRing) Bytes() []byte {
	if r == nil {
		return nil
	}
	if !r.full {
		return append([]byte(nil), r.buf[:r.pos]...)
	}
	out := make([]byte, 0, len(r.buf))
	out = append(out, r.buf[r.pos:]...)
	out = append(out, r.buf[:r.pos]...)
	return out
}

func (r *ByteRing) Reset() {
	if r == nil {
		return
	}
	r.pos = 0
	r.full = false
}

func (r *ByteRing) SetLimit(size int) {
	if r == nil || size <= 0 || size == len(r.buf) {
		return
	}
	current := r.Bytes()
	r.buf = make([]byte, size)
	r.pos = 0
	r.full = false
	r.Write(current)
}
