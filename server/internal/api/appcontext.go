package api

import (
	"context"
	"errors"
	"sync"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/audit"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/router"
	"mindfs/server/internal/session"
)

type RootContext struct {
	Root    fs.RootInfo
	View    *router.ViewManager
	Session *session.Manager
	Watcher *fs.SharedFileWatcher
}

type AppContext struct {
	Dirs   *fs.Registry
	Audit  *audit.WriterPool
	Agents *agent.Pool
	Prober *agent.Prober

	mu    sync.RWMutex
	roots map[string]*RootContext // root id -> root context
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

func (s *AppContext) GetViewManager(rootID string) (*router.ViewManager, error) {
	rootCtx, err := s.GetRootContext(rootID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if rootCtx.View != nil {
		return rootCtx.View, nil
	}
	vm, err := router.NewViewManager(rootCtx.Root)
	if err != nil {
		return nil, err
	}
	rootCtx.View = vm
	return vm, nil
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

	opts := []session.Option{}
	if s.Audit != nil {
		logger := audit.NewLogger(s.Audit, rootCtx.Root)
		opts = append(opts, session.WithAuditLogger(auditLoggerAdapter{logger: logger}))
	}
	mgr := session.NewManager(rootCtx.Root, opts...)
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

func (s *AppContext) UpsertRoot(path string) (fs.RootInfo, error) {
	if s.Dirs == nil {
		return fs.RootInfo{}, errors.New("registry not configured")
	}
	return s.Dirs.Upsert(path)
}

func (s *AppContext) ListRoots() []fs.RootInfo {
	if s.Dirs == nil {
		return []fs.RootInfo{}
	}
	return s.Dirs.List()
}

type auditLoggerAdapter struct {
	logger *audit.Logger
}

func (a auditLoggerAdapter) LogSession(action, actor, sessionKey, agentName string, details map[string]any) error {
	if a.logger == nil {
		return nil
	}
	return a.logger.LogSession(audit.Action(action), audit.Actor(actor), sessionKey, agentName, details)
}
