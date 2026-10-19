package historycache

import (
	"os"
	"path/filepath"
	"sync"
)

// Metadata caches small, immutable file headers. Directory discovery still
// visits every candidate so newly created child sessions are never hidden.
type Metadata[T any] struct {
	mu      sync.Mutex
	entries map[string]metadataEntry[T]
	order   []string
}

type metadataEntry[T any] struct {
	info  os.FileInfo
	value T
}

func (c *Metadata[T]) Read(path string, load func() (T, error)) (T, error) {
	var zero T
	path = filepath.Clean(path)
	info, err := os.Stat(path)
	if err != nil {
		return zero, err
	}
	c.mu.Lock()
	previous, ok := c.entries[path]
	c.mu.Unlock()
	if ok && os.SameFile(previous.info, info) && previous.info.Size() == info.Size() && previous.info.ModTime().Equal(info.ModTime()) {
		return previous.value, nil
	}
	value, err := load()
	if err != nil {
		return zero, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]metadataEntry[T])
	}
	if _, ok := c.entries[path]; !ok {
		if len(c.order) >= 2048 {
			delete(c.entries, c.order[0])
			c.order = c.order[1:]
		}
		c.order = append(c.order, path)
	}
	c.entries[path] = metadataEntry[T]{info: info, value: value}
	return value, nil
}
