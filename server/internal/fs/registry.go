package fs

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	configpkg "mindfs/server/internal/config"
)

type Registry struct {
	mu    sync.Mutex
	path  string
	dirs  map[string]RootInfo
	order []string
}

func NewRegistry(path string) *Registry {
	return &Registry{path: path, dirs: make(map[string]RootInfo)}
}

func NewDefaultRegistry() (*Registry, error) {
	configDir, err := configpkg.MindFSConfigDir()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(configDir, "registry.json")
	return NewRegistry(path), nil
}

func (r *Registry) Load() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	payload, err := os.ReadFile(r.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var stored struct {
		Dirs  []RootInfo `json:"dirs"`
		Order []string   `json:"order"`
	}
	if err := json.Unmarshal(payload, &stored); err != nil {
		return err
	}
	r.dirs = make(map[string]RootInfo)
	r.order = nil
	seen := make(map[string]struct{})
	for _, info := range stored.Dirs {
		name := info.Name
		if name == "" {
			name = filepath.Base(info.RootPath)
		}
		if name == "" || name == "." || name == string(filepath.Separator) {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		info.Name = name
		info.ID = name
		r.dirs[name] = info
		r.order = append(r.order, name)
	}
	return nil
}

func (r *Registry) Save() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.saveLocked()
}

func (r *Registry) saveLocked() error {
	if r.path == "" {
		return errors.New("registry path required")
	}
	if err := os.MkdirAll(filepath.Dir(r.path), 0o755); err != nil {
		return err
	}
	recs := make([]RootInfo, 0, len(r.dirs))
	for _, id := range r.order {
		if dir, ok := r.dirs[id]; ok {
			recs = append(recs, dir)
		}
	}
	payload, err := json.MarshalIndent(map[string]any{"dirs": recs, "order": r.order}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(r.path, payload, 0o644)
}

func (r *Registry) List() []RootInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]RootInfo, 0, len(r.order))
	for _, id := range r.order {
		if dir, ok := r.dirs[id]; ok {
			result = append(result, dir)
		}
	}
	return result
}

func (r *Registry) Get(id string) (RootInfo, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	dir, ok := r.dirs[id]
	return dir, ok
}

func (r *Registry) Upsert(root string) (RootInfo, error) {
	if root == "" {
		return RootInfo{}, errors.New("root required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now().UTC()
	name := filepath.Base(root)
	if name == "" || name == "." || name == string(filepath.Separator) {
		return RootInfo{}, errors.New("invalid directory name")
	}
	dir, ok := r.dirs[name]
	if !ok {
		dir = NewRootInfo(name, name, root)
		dir.CreatedAt = now
		r.order = append(r.order, name)
	}
	dir.UpdatedAt = now
	r.dirs[name] = dir
	return dir, r.saveLocked()
}
