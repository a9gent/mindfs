package fs

import (
	"context"
	iofs "io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// SharedFileWatcher manages file watching for one root shared by multiple sessions.
type SharedFileWatcher struct {
	root         RootInfo
	watcher      *fsnotify.Watcher
	sessionStore SessionFileRecorder

	mu            sync.RWMutex
	sessions      map[string]*sessionInfo
	pendingWrites map[string]string
	onFileChange  func(FileChangeEvent)

	done chan struct{}
}

type SessionFileRecorder interface {
	RecordOutputFile(ctx context.Context, key, path string) error
}

type sessionInfo struct {
	key string
}

type FileChangeEvent struct {
	RootID string `json:"root_id"`
	Path   string `json:"path"`
	Op     string `json:"op"`
	IsDir  bool   `json:"is_dir"`
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
		if closeErr := w.Close(); closeErr != nil {
		}
		return nil, err
	}
	go sw.run()
	return sw, nil
}

func (sw *SharedFileWatcher) RegisterSession(sessionKey string) {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	sw.sessions[sessionKey] = &sessionInfo{key: sessionKey}
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
}

func (sw *SharedFileWatcher) MarkSessionActive(_ string) {
}

func (sw *SharedFileWatcher) RecordPendingWrite(sessionKey, filePath string) {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	if rel, err := sw.root.NormalizePath(filePath); err == nil {
		filePath = rel
	}
	filePath = filepath.ToSlash(filePath)
	sw.pendingWrites[filePath] = sessionKey
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
	sw.sessionStore.RecordOutputFile(context.Background(), sessionKey, relPath)
	sw.root.UpdateFileMeta(relPath, sessionKey, "agent")
}

func (sw *SharedFileWatcher) SetOnFileChange(handler func(FileChangeEvent)) {
	sw.mu.Lock()
	sw.onFileChange = handler
	sw.mu.Unlock()
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
	sw.watcher.Close()
}

func (sw *SharedFileWatcher) run() {
	for {
		select {
		case event, ok := <-sw.watcher.Events:
			if !ok {
				return
			}
			if event.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Rename|fsnotify.Remove) == 0 {
				continue
			}
			if sw.shouldIgnore(event.Name) {
				continue
			}
			rel, err := sw.root.NormalizePath(event.Name)
			if err != nil {
				continue
			}
			if event.Op&fsnotify.Remove != 0 {
				sw.emitFileChange(FileChangeEvent{
					RootID: sw.root.ID,
					Path:   rel,
					Op:     event.Op.String(),
					IsDir:  false,
				})
				continue
			}
			info, err := os.Stat(event.Name)
			if err != nil {
				// File might disappear quickly during rename/remove races.
				sw.emitFileChange(FileChangeEvent{
					RootID: sw.root.ID,
					Path:   rel,
					Op:     event.Op.String(),
					IsDir:  false,
				})
				continue
			}
			if info.IsDir() {
				sw.emitFileChange(FileChangeEvent{
					RootID: sw.root.ID,
					Path:   rel,
					Op:     event.Op.String(),
					IsDir:  true,
				})
				sw.addWatchRecursive(rel)
				continue
			}
			sw.emitFileChange(FileChangeEvent{
				RootID: sw.root.ID,
				Path:   rel,
				Op:     event.Op.String(),
				IsDir:  false,
			})
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
	return ""
}

func (sw *SharedFileWatcher) emitFileChange(change FileChangeEvent) {
	sw.mu.RLock()
	handler := sw.onFileChange
	sw.mu.RUnlock()
	if handler != nil {
		handler(change)
	}
}

func (sw *SharedFileWatcher) addWatchRecursive(startRel string) error {
	startAbs, err := sw.root.resolveRelativePath(startRel)
	if err != nil {
		return err
	}
	return filepath.WalkDir(startAbs, func(entryPath string, d iofs.DirEntry, err error) error {
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
			sw.watcher.Add(entryPath)
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
