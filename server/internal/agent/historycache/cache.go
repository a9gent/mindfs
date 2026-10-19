// Package historycache keeps JSONL parser state between reads. This is a read
// cache, not a persistence checkpoint: consumers still commit their own cursors
// only after exchanges have been stored successfully.
package historycache

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sync"
)

type Parser[T any] struct {
	Feed     func(string) error
	Snapshot func() T
	Reusable func() bool
}

type entry[T any] struct {
	mu     sync.Mutex
	info   os.FileInfo
	offset int64
	parser Parser[T]
	head   []byte
	tail   []byte
}

// Cache retains at most eight histories, each at most 32 MiB of source data.
// Different files can be parsed concurrently. Eviction only costs a cold read.
type Cache[T any] struct {
	mu      sync.Mutex
	entries map[string]*entry[T]
	order   []string
}

func (c *Cache[T]) Forget(path string) {
	path = filepath.Clean(path)
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, path)
	for i, key := range c.order {
		if key == path {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
}

func (c *Cache[T]) Read(path string, create func() Parser[T], selectResult func(T) T) (T, error) {
	var zero T
	path = filepath.Clean(path)
	c.mu.Lock()
	if c.entries == nil {
		c.entries = make(map[string]*entry[T])
	}
	e := c.entries[path]
	if e == nil {
		if len(c.order) >= 8 {
			delete(c.entries, c.order[0])
			c.order = c.order[1:]
		}
		e = &entry[T]{}
		c.entries[path] = e
		c.order = append(c.order, path)
	}
	c.mu.Unlock()
	e.mu.Lock()
	defer e.mu.Unlock()
	f, err := os.Open(path)
	if err != nil {
		e.info = nil
		return zero, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		e.info = nil
		return zero, err
	}
	// Replacements, truncations and same-size rewrites invalidate parser state.
	if e.info == nil || !os.SameFile(e.info, info) || info.Size() < e.info.Size() ||
		(info.Size() == e.info.Size() && !info.ModTime().Equal(e.info.ModTime())) ||
		!matchesBoundary(f, e.offset, e.head, e.tail) {
		e.parser = create()
		e.offset = 0
	}
	if _, err = f.Seek(e.offset, io.SeekStart); err != nil {
		e.info = nil
		return zero, err
	}
	reader := bufio.NewReader(io.LimitReader(f, info.Size()-e.offset))
	cacheable := info.Size() <= 32<<20
	for {
		line, readErr := reader.ReadBytes('\n')
		if readErr != nil && readErr != io.EOF {
			e.info = nil
			return zero, readErr
		}
		if len(line) > 0 {
			if line[len(line)-1] != '\n' {
				// Accept a complete final JSON value for legacy logs, but never
				// retain state past an unterminated record that may still grow.
				if !json.Valid(line) {
					break
				}
				cacheable = false
			}
			if err = e.parser.Feed(string(line)); err != nil {
				e.info = nil
				return zero, err
			}
			e.offset += int64(len(line))
		}
		if readErr == io.EOF {
			break
		}
	}
	result := e.parser.Snapshot()
	if selectResult != nil {
		result = selectResult(result)
	}
	// Snapshots must not share tool-call maps/slices with the mutable parser.
	detached := clone(reflect.ValueOf(result)).Interface().(T)
	e.info = info
	e.head, e.tail = boundary(f, e.offset)
	// A writer may have changed the file while it was being parsed. Return this
	// snapshot, but rebuild next time instead of trusting a mixed checkpoint.
	latest, statErr := f.Stat()
	if statErr != nil || latest.Size() != info.Size() || !latest.ModTime().Equal(info.ModTime()) {
		cacheable = false
	}
	if !cacheable || (e.parser.Reusable != nil && !e.parser.Reusable()) {
		e.info = nil
		e.parser = Parser[T]{}
	}
	return detached, nil
}

// Check both ends of the consumed prefix before trusting an append. This also
// detects common in-place rewrites followed by growth without rereading history.
func boundary(f *os.File, offset int64) ([]byte, []byte) {
	n := min(offset, int64(256))
	head, tail := make([]byte, n), make([]byte, n)
	if _, err := f.ReadAt(head, 0); err != nil && n > 0 {
		return nil, nil
	}
	if _, err := f.ReadAt(tail, offset-n); err != nil && n > 0 {
		return nil, nil
	}
	return head, tail
}

func matchesBoundary(f *os.File, offset int64, head, tail []byte) bool {
	if offset == 0 {
		return true
	}
	h, t := boundary(f, offset)
	return len(head) > 0 && bytes.Equal(head, h) && bytes.Equal(tail, t)
}

// Preserve concrete numbers in tool metadata (a JSON round trip turns ints
// into floats). Parser snapshots contain data only, with no cyclic references.
func clone(v reflect.Value) reflect.Value {
	switch v.Kind() {
	case reflect.Interface, reflect.Pointer:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		out := reflect.New(v.Type()).Elem()
		if v.Kind() == reflect.Pointer {
			out.Set(reflect.New(v.Type().Elem()))
			out.Elem().Set(clone(v.Elem()))
		} else {
			out.Set(clone(v.Elem()))
		}
		return out
	case reflect.Slice:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		out := reflect.MakeSlice(v.Type(), v.Len(), v.Len())
		for i := 0; i < v.Len(); i++ {
			out.Index(i).Set(clone(v.Index(i)))
		}
		return out
	case reflect.Map:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		out := reflect.MakeMapWithSize(v.Type(), v.Len())
		it := v.MapRange()
		for it.Next() {
			out.SetMapIndex(it.Key(), clone(it.Value()))
		}
		return out
	case reflect.Struct:
		out := reflect.New(v.Type()).Elem()
		out.Set(v)
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				out.Field(i).Set(clone(v.Field(i)))
			}
		}
		return out
	default:
		return v
	}
}

// Complete reports whether a fingerprint can safely describe all bytes read.
func Complete(path string, size int64) bool {
	if size == 0 {
		return true
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var tail [1]byte
	_, err = f.ReadAt(tail[:], size-1)
	return err == nil && tail[0] == '\n'
}
