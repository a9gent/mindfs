package fs

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// SharedFileWatcher manages file watching for a rootPath shared by multiple sessions.
// It tracks file writes via ToolCall (precise) and falls back to most recently active session.
type SharedFileWatcher struct {
	rootPath   string
	managedDir string
	watcher    *fsnotify.Watcher

	mu              sync.RWMutex
	sessions        map[string]*sessionInfo       // sessionKey -> info
	pendingWrites   map[string]string             // filePath -> sessionKey (from ToolCall)
	lastActiveKey   string                        // most recently active session
	lastActiveTime  time.Time
	onFileCreated   func(relativePath, sessionKey string, size int64)

	done chan struct{}
}

type sessionInfo struct {
	key        string
	lastActive time.Time
}

// SharedWatcherManager manages SharedFileWatcher instances per rootPath.
type SharedWatcherManager struct {
	mu       sync.Mutex
	watchers map[string]*SharedFileWatcher // rootPath -> watcher
}

var sharedWatcherManager = &SharedWatcherManager{
	watchers: make(map[string]*SharedFileWatcher),
}

// GetSharedWatcher returns or creates a SharedFileWatcher for the given rootPath.
func GetSharedWatcher(rootPath, managedDir string, onFileCreated func(relativePath, sessionKey string, size int64)) (*SharedFileWatcher, error) {
	return sharedWatcherManager.GetOrCreate(rootPath, managedDir, onFileCreated)
}

// GetOrCreate returns an existing watcher or creates a new one.
func (m *SharedWatcherManager) GetOrCreate(rootPath, managedDir string, onFileCreated func(relativePath, sessionKey string, size int64)) (*SharedFileWatcher, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if sw, ok := m.watchers[rootPath]; ok {
		// Update callback if provided
		if onFileCreated != nil {
			sw.mu.Lock()
			sw.onFileCreated = onFileCreated
			sw.mu.Unlock()
		}
		return sw, nil
	}

	sw, err := newSharedFileWatcher(rootPath, managedDir, onFileCreated)
	if err != nil {
		return nil, err
	}
	m.watchers[rootPath] = sw
	return sw, nil
}

// Remove removes a watcher for the given rootPath.
func (m *SharedWatcherManager) Remove(rootPath string) {
	m.mu.Lock()
	sw, ok := m.watchers[rootPath]
	if ok {
		delete(m.watchers, rootPath)
	}
	m.mu.Unlock()

	if ok && sw != nil {
		sw.Close()
	}
}

func newSharedFileWatcher(rootPath, managedDir string, onFileCreated func(relativePath, sessionKey string, size int64)) (*SharedFileWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	sw := &SharedFileWatcher{
		rootPath:      rootPath,
		managedDir:    managedDir,
		watcher:       w,
		sessions:      make(map[string]*sessionInfo),
		pendingWrites: make(map[string]string),
		onFileCreated: onFileCreated,
		done:          make(chan struct{}),
	}

	if err := sw.addWatchRecursive(rootPath); err != nil {
		_ = w.Close()
		return nil, err
	}

	go sw.run()
	return sw, nil
}

// RegisterSession registers a session with this watcher.
func (sw *SharedFileWatcher) RegisterSession(sessionKey string) {
	sw.mu.Lock()
	defer sw.mu.Unlock()

	now := time.Now()
	sw.sessions[sessionKey] = &sessionInfo{
		key:        sessionKey,
		lastActive: now,
	}
	sw.lastActiveKey = sessionKey
	sw.lastActiveTime = now
}

// UnregisterSession removes a session from this watcher.
func (sw *SharedFileWatcher) UnregisterSession(sessionKey string) {
	sw.mu.Lock()
	defer sw.mu.Unlock()

	delete(sw.sessions, sessionKey)

	// Clean up pending writes for this session
	for path, key := range sw.pendingWrites {
		if key == sessionKey {
			delete(sw.pendingWrites, path)
		}
	}

	// Update lastActiveKey if needed
	if sw.lastActiveKey == sessionKey {
		sw.lastActiveKey = ""
		var latestTime time.Time
		for _, info := range sw.sessions {
			if info.lastActive.After(latestTime) {
				latestTime = info.lastActive
				sw.lastActiveKey = info.key
			}
		}
		sw.lastActiveTime = latestTime
	}
}

// MarkSessionActive marks a session as recently active.
func (sw *SharedFileWatcher) MarkSessionActive(sessionKey string) {
	sw.mu.Lock()
	defer sw.mu.Unlock()

	now := time.Now()
	if info, ok := sw.sessions[sessionKey]; ok {
		info.lastActive = now
	}
	sw.lastActiveKey = sessionKey
	sw.lastActiveTime = now
}

// RecordPendingWrite records that a session is about to write to a file (from ToolCall).
func (sw *SharedFileWatcher) RecordPendingWrite(sessionKey, filePath string) {
	sw.mu.Lock()
	defer sw.mu.Unlock()

	// Normalize path
	if filepath.IsAbs(filePath) {
		if rel, err := filepath.Rel(sw.rootPath, filePath); err == nil && !strings.HasPrefix(rel, "..") {
			filePath = rel
		}
	}
	filePath = filepath.ToSlash(filePath)

	sw.pendingWrites[filePath] = sessionKey

	// Also mark session as active
	now := time.Now()
	if info, ok := sw.sessions[sessionKey]; ok {
		info.lastActive = now
	}
	sw.lastActiveKey = sessionKey
	sw.lastActiveTime = now
}

// SessionCount returns the number of registered sessions.
func (sw *SharedFileWatcher) SessionCount() int {
	sw.mu.RLock()
	defer sw.mu.RUnlock()
	return len(sw.sessions)
}

// Close stops the watcher.
func (sw *SharedFileWatcher) Close() {
	sw.mu.Lock()
	select {
	case <-sw.done:
		sw.mu.Unlock()
		return
	default:
		close(sw.done)
	}
	sw.mu.Unlock()
	_ = sw.watcher.Close()
}

func (sw *SharedFileWatcher) run() {
	for {
		select {
		case event, ok := <-sw.watcher.Events:
			if !ok {
				return
			}
			// Only handle Create and Write events
			if event.Op&(fsnotify.Create|fsnotify.Write) == 0 {
				continue
			}
			if sw.shouldIgnore(event.Name) {
				continue
			}
			info, err := os.Stat(event.Name)
			if err != nil {
				continue
			}
			if info.IsDir() {
				_ = sw.addWatchRecursive(event.Name)
				continue
			}

			rel, err := filepath.Rel(sw.rootPath, event.Name)
			if err != nil {
				continue
			}
			relSlash := filepath.ToSlash(rel)

			// Determine which session owns this file
			sessionKey := sw.resolveSessionKey(relSlash)
			if sessionKey == "" {
				continue
			}

			// Update file-meta.json
			if sw.managedDir != "" {
				_ = UpdateFileMeta(sw.managedDir, rel, sessionKey, "agent")
			}

			// Call callback
			sw.mu.RLock()
			callback := sw.onFileCreated
			sw.mu.RUnlock()

			if callback != nil {
				callback(rel, sessionKey, info.Size())
			}

		case _, ok := <-sw.watcher.Errors:
			if !ok {
				return
			}
		case <-sw.done:
			return
		}
	}
}

// resolveSessionKey determines which session owns a file write.
// Priority: 1. Pending write from ToolCall (precise), 2. Most recently active session (fallback)
func (sw *SharedFileWatcher) resolveSessionKey(relPath string) string {
	sw.mu.Lock()
	defer sw.mu.Unlock()

	// 1. Check pending writes (from ToolCall - precise matching)
	if sessionKey, ok := sw.pendingWrites[relPath]; ok {
		delete(sw.pendingWrites, relPath) // Consume the pending write
		return sessionKey
	}

	// 2. Fallback to most recently active session
	if sw.lastActiveKey != "" {
		// Only use if activity was recent (within 30 seconds)
		if time.Since(sw.lastActiveTime) < 30*time.Second {
			return sw.lastActiveKey
		}
	}

	// 3. No session found
	return ""
}

func (sw *SharedFileWatcher) addWatchRecursive(path string) error {
	return filepath.WalkDir(path, func(entryPath string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if sw.shouldIgnore(entryPath) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			_ = sw.watcher.Add(entryPath)
		}
		return nil
	})
}

func (sw *SharedFileWatcher) shouldIgnore(path string) bool {
	if sw.managedDir != "" && strings.HasPrefix(path, sw.managedDir) {
		return true
	}
	// Ignore common non-user directories
	base := filepath.Base(path)
	if base == ".git" || base == "node_modules" || base == ".DS_Store" {
		return true
	}
	return false
}
