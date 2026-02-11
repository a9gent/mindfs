package fs

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// SharedFileWatcher manages file watching for one root shared by multiple sessions.
type SharedFileWatcher struct {
	root         RootInfo
	watcher      *fsnotify.Watcher
	sessionStore SessionFileRecorder

	mu             sync.RWMutex
	sessions       map[string]*sessionInfo
	pendingWrites  map[string]string
	lastActiveKey  string
	lastActiveTime time.Time

	done chan struct{}
}

type SessionFileRecorder interface {
	RecordOutputFile(ctx context.Context, key, path string) error
}

type sessionInfo struct {
	key        string
	lastActive time.Time
}

func NewSharedFileWatcher(root RootInfo, sessions SessionFileRecorder) (*SharedFileWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	sw := &SharedFileWatcher{
		root:          root,
		watcher:       w,
		sessionStore:  sessions,
		sessions:      make(map[string]*sessionInfo),
		pendingWrites: make(map[string]string),
		done:          make(chan struct{}),
	}
	if err := sw.addWatchRecursive("."); err != nil {
		_ = w.Close()
		return nil, err
	}
	go sw.run()
	return sw, nil
}

func (sw *SharedFileWatcher) RegisterSession(sessionKey string) {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	now := time.Now()
	sw.sessions[sessionKey] = &sessionInfo{key: sessionKey, lastActive: now}
	sw.lastActiveKey = sessionKey
	sw.lastActiveTime = now
}

func (sw *SharedFileWatcher) UnregisterSession(sessionKey string) {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	delete(sw.sessions, sessionKey)
	for path, key := range sw.pendingWrites {
		if key == sessionKey {
			delete(sw.pendingWrites, path)
		}
	}
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

func (sw *SharedFileWatcher) RecordPendingWrite(sessionKey, filePath string) {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	if rel, err := sw.root.NormalizePath(filePath); err == nil {
		filePath = rel
	}
	filePath = filepath.ToSlash(filePath)
	sw.pendingWrites[filePath] = sessionKey
	now := time.Now()
	if info, ok := sw.sessions[sessionKey]; ok {
		info.lastActive = now
	}
	sw.lastActiveKey = sessionKey
	sw.lastActiveTime = now
}

func (sw *SharedFileWatcher) RecordSessionFile(sessionKey, filePath string) {
	if sw.sessionStore == nil || sessionKey == "" || filePath == "" {
		return
	}
	relPath := filePath
	if rel, err := sw.root.NormalizePath(filePath); err == nil {
		relPath = rel
	}
	relPath = filepath.ToSlash(relPath)
	if relPath == "." || relPath == ".." || relPath == "" {
		return
	}
	if len(relPath) >= len(".mindfs") && relPath[:len(".mindfs")] == ".mindfs" {
		return
	}
	_ = sw.sessionStore.RecordOutputFile(context.Background(), sessionKey, relPath)
	_ = sw.root.UpdateFileMeta(relPath, sessionKey, "agent")
}

func (sw *SharedFileWatcher) SessionCount() int {
	sw.mu.RLock()
	defer sw.mu.RUnlock()
	return len(sw.sessions)
}

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
				if rel, err := sw.root.NormalizePath(event.Name); err == nil {
					_ = sw.addWatchRecursive(rel)
				}
				continue
			}
			rel, err := sw.root.NormalizePath(event.Name)
			if err != nil {
				continue
			}
			sessionKey := sw.resolveSessionKey(rel)
			if sessionKey == "" {
				continue
			}
			sw.RecordSessionFile(sessionKey, rel)
		case _, ok := <-sw.watcher.Errors:
			if !ok {
				return
			}
		case <-sw.done:
			return
		}
	}
}

func (sw *SharedFileWatcher) resolveSessionKey(relPath string) string {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	if sessionKey, ok := sw.pendingWrites[relPath]; ok {
		delete(sw.pendingWrites, relPath)
		return sessionKey
	}
	if sw.lastActiveKey != "" && time.Since(sw.lastActiveTime) < 30*time.Second {
		return sw.lastActiveKey
	}
	return ""
}

func (sw *SharedFileWatcher) addWatchRecursive(startRel string) error {
	startAbs, err := sw.root.resolveRelativePath(startRel)
	if err != nil {
		return err
	}
	return filepath.WalkDir(startAbs, func(entryPath string, d fs.DirEntry, err error) error {
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
	metaDir := sw.root.MetaDir()
	if metaDir != "" && strings.HasPrefix(path, metaDir) {
		return true
	}
	base := filepath.Base(path)
	return base == ".git" || base == "node_modules" || base == ".DS_Store"
}
