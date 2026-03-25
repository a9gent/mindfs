package api

import (
	"context"
	"errors"
	"sync"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/api/usecase"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/relay"
	"mindfs/server/internal/session"
)

type RootContext struct {
	Root    fs.RootInfo
	Session *session.Manager
	Watcher *fs.SharedFileWatcher
}

type AppContext struct {
	Dirs   *fs.Registry
	Agents *agent.Pool
	Prober *agent.Prober
	Relay  *relay.Manager

	mu                  sync.RWMutex
	roots               map[string]*RootContext // root id -> root context
	fileChangeListeners []func(fs.FileChangeEvent)
	streamHub           *StreamHub
	candidateRegistry   *usecase.CandidateRegistry
}

func (s *AppContext) GetRootContext(rootID string) (*RootContext, error) {
	if rootID == "" {
		return nil, errors.New("root id required")
	}
	if s.Dirs == nil {
		return nil, errors.New("registry not configured")
	}
	root, ok := s.Dirs.Get(rootID)
	if !ok {
		return nil, errors.New("root not found")
	}
	if root.ID == "" {
		return nil, errors.New("invalid root")
	}

	s.mu.RLock()
	if ctx, ok := s.roots[root.ID]; ok {
		s.mu.RUnlock()
		return ctx, nil
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.roots == nil {
		s.roots = make(map[string]*RootContext)
	}
	if ctx, ok := s.roots[root.ID]; ok {
		return ctx, nil
	}
	ctx := &RootContext{Root: root}
	s.roots[root.ID] = ctx
	return ctx, nil
}

func (s *AppContext) GetRoot(rootID string) (fs.RootInfo, error) {
	rootCtx, err := s.GetRootContext(rootID)
	if err != nil {
		return fs.RootInfo{}, err
	}
	return rootCtx.Root, nil
}

func (s *AppContext) GetSessionManager(rootID string) (*session.Manager, error) {
	rootCtx, err := s.GetRootContext(rootID)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if rootCtx.Session != nil {
		return rootCtx.Session, nil
	}
	mgr := session.NewManager(rootCtx.Root)
	mgr.StartIdleLoop(context.Background())
	rootCtx.Session = mgr

	return mgr, nil
}

func (s *AppContext) GetFileWatcher(rootID string, manager *session.Manager) (*fs.SharedFileWatcher, error) {
	rootCtx, err := s.GetRootContext(rootID)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if rootCtx.Watcher != nil {
		return rootCtx.Watcher, nil
	}
	watcher, err := fs.NewSharedFileWatcher(rootCtx.Root, manager)
	if err != nil {
		return nil, err
	}
	watcher.SetOnFileChange(s.emitFileChange)
	rootCtx.Watcher = watcher
	return watcher, nil
}

func (s *AppContext) ReleaseFileWatcher(rootID, sessionKey string) {
	rootCtx, err := s.GetRootContext(rootID)
	if err != nil {
		return
	}

	s.mu.Lock()
	watcher := rootCtx.Watcher
	s.mu.Unlock()
	if watcher == nil {
		return
	}

	watcher.UnregisterSession(sessionKey)
	if watcher.SessionCount() > 0 {
		return
	}

	s.mu.Lock()
	if rootCtx.Watcher == watcher {
		rootCtx.Watcher = nil
	}
	s.mu.Unlock()
	watcher.Close()
}

func (s *AppContext) GetAgentPool() *agent.Pool {
	return s.Agents
}

func (s *AppContext) GetProber() *agent.Prober {
	return s.Prober
}

func (s *AppContext) GetDirRegistry() *fs.Registry {
	return s.Dirs
}

func (s *AppContext) GetRelayManager() *relay.Manager {
	return s.Relay
}

func (s *AppContext) UpsertRoot(path string) (fs.RootInfo, error) {
	if s.Dirs == nil {
		return fs.RootInfo{}, errors.New("registry not configured")
	}
	return s.Dirs.Upsert(path)
}

func (s *AppContext) RemoveRoot(path string) (fs.RootInfo, error) {
	if s.Dirs == nil {
		return fs.RootInfo{}, errors.New("registry not configured")
	}
	dir, err := s.Dirs.Remove(path)
	if err != nil {
		return fs.RootInfo{}, err
	}
	s.mu.Lock()
	rootCtx := s.roots[dir.ID]
	delete(s.roots, dir.ID)
	s.mu.Unlock()
	if rootCtx != nil && rootCtx.Watcher != nil {
		rootCtx.Watcher.Close()
	}
	return dir, nil
}

func (s *AppContext) ListRoots() []fs.RootInfo {
	if s.Dirs == nil {
		return []fs.RootInfo{}
	}
	return s.Dirs.List()
}

func (s *AppContext) AddFileChangeListener(listener func(fs.FileChangeEvent)) {
	if listener == nil {
		return
	}
	s.mu.Lock()
	s.fileChangeListeners = append(s.fileChangeListeners, listener)
	s.mu.Unlock()
}

func (s *AppContext) emitFileChange(change fs.FileChangeEvent) {
	s.mu.RLock()
	listeners := append([]func(fs.FileChangeEvent){}, s.fileChangeListeners...)
	s.mu.RUnlock()
	for _, listener := range listeners {
		listener(change)
	}
}

func (s *AppContext) GetSessionStreamHub() *StreamHub {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.streamHub == nil {
		s.streamHub = NewStreamHub()
	}
	return s.streamHub
}

func (s *AppContext) GetCandidateRegistry() *usecase.CandidateRegistry {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.candidateRegistry == nil {
		registry := usecase.NewCandidateRegistry()
		registry.Register(usecase.NewFileCandidateProvider())
		registry.Register(usecase.NewSkillCandidateProvider())
		registry.Register(usecase.NewSlashCommandCandidateProvider(func(agentName string) (agent.Status, bool) {
			if s.Prober == nil {
				return agent.Status{}, false
			}
			return s.Prober.GetStatus(agentName)
		}))
		s.candidateRegistry = registry
	}
	return s.candidateRegistry
}
