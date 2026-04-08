package fs

import (
	"context"
	iofs "io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

const fileChangeBatchDelay = time.Second

// SharedFileWatcher manages file watching for one root shared by multiple sessions.
type SharedFileWatcher struct {
	root         RootInfo
	watcher      *fsnotify.Watcher
	sessionStore SessionFileRecorder

	mu                sync.RWMutex
	sessions          map[string]*sessionInfo
	pendingWrites     map[string]string
	pendingChanges    map[string]FileChangeEvent
	pendingChangeDirs map[string]struct{}
	fileChangeTimer   *time.Timer
	fileChangeVersion uint64
	onFileChange      func(FileChangeEvent)
	onFileChangeBatch func(FileChangeBatchEvent)
	onRelatedFile     func(RelatedFileEvent)

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

type FileChangeBatchEvent struct {
	RootID string            `json:"root_id"`
	Paths  []string          `json:"paths"`
	Dirs   []string          `json:"dirs"`
	Events []FileChangeEvent `json:"events"`
}

type RelatedFileEvent struct {
	RootID     string `json:"root_id"`
	SessionKey string `json:"session_key"`
	Path       string `json:"path"`
}

func NewSharedFileWatcher(root RootInfo, sessions SessionFileRecorder) (*SharedFileWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	sw := &SharedFileWatcher{
		root:              root,
		watcher:           w,
		sessionStore:      sessions,
		sessions:          make(map[string]*sessionInfo),
		pendingWrites:     make(map[string]string),
		pendingChanges:    make(map[string]FileChangeEvent),
		pendingChangeDirs: make(map[string]struct{}),
		done:              make(chan struct{}),
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
	relPath, err := sw.root.NormalizePath(filePath)
	if err != nil {
		return
	}
	relPath = filepath.ToSlash(relPath)
	if relPath == "." || relPath == ".." || relPath == "" {
		return
	}
	if len(relPath) >= len(".mindfs") && relPath[:len(".mindfs")] == ".mindfs" {
		return
	}
	if err := sw.sessionStore.RecordOutputFile(context.Background(), sessionKey, relPath); err != nil {
		return
	}
	sw.root.UpdateFileMeta(relPath, sessionKey, "agent")
	sw.emitRelatedFile(RelatedFileEvent{
		RootID:     sw.root.ID,
		SessionKey: sessionKey,
		Path:       relPath,
	})
}

func (sw *SharedFileWatcher) SetOnFileChange(handler func(FileChangeEvent)) {
	sw.mu.Lock()
	sw.onFileChange = handler
	sw.mu.Unlock()
}

func (sw *SharedFileWatcher) SetOnFileChangeBatch(handler func(FileChangeBatchEvent)) {
	sw.mu.Lock()
	sw.onFileChangeBatch = handler
	sw.mu.Unlock()
}

func (sw *SharedFileWatcher) SetOnRelatedFile(handler func(RelatedFileEvent)) {
	sw.mu.Lock()
	sw.onRelatedFile = handler
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
	sw.flushFileChangeBatch(0)
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
	sw.queueFileChangeBatch(change)
}

func (sw *SharedFileWatcher) queueFileChangeBatch(change FileChangeEvent) {
	change.Path = filepath.ToSlash(change.Path)
	if change.Path == "" {
		return
	}
	sw.mu.Lock()
	select {
	case <-sw.done:
		sw.mu.Unlock()
		return
	default:
	}
	if sw.pendingChanges == nil {
		sw.pendingChanges = make(map[string]FileChangeEvent)
	}
	if sw.pendingChangeDirs == nil {
		sw.pendingChangeDirs = make(map[string]struct{})
	}
	sw.pendingChanges[change.Path] = change
	sw.pendingChangeDirs[parentDir(change.Path)] = struct{}{}
	if change.IsDir || strings.Contains(change.Op, "REMOVE") || strings.Contains(change.Op, "RENAME") {
		sw.pendingChangeDirs[change.Path] = struct{}{}
	}
	sw.fileChangeVersion++
	version := sw.fileChangeVersion
	if sw.fileChangeTimer != nil {
		sw.fileChangeTimer.Stop()
	}
	sw.fileChangeTimer = time.AfterFunc(fileChangeBatchDelay, func() {
		sw.flushFileChangeBatch(version)
	})
	sw.mu.Unlock()
}

func (sw *SharedFileWatcher) flushFileChangeBatch(version uint64) {
	sw.mu.Lock()
	if version != 0 && version != sw.fileChangeVersion {
		sw.mu.Unlock()
		return
	}
	if sw.fileChangeTimer != nil {
		sw.fileChangeTimer.Stop()
		sw.fileChangeTimer = nil
	}
	if len(sw.pendingChanges) == 0 {
		sw.mu.Unlock()
		return
	}
	changesByPath := sw.pendingChanges
	dirsByPath := sw.pendingChangeDirs
	sw.pendingChanges = make(map[string]FileChangeEvent)
	sw.pendingChangeDirs = make(map[string]struct{})
	batchHandler := sw.onFileChangeBatch
	singleHandler := sw.onFileChange
	sw.mu.Unlock()

	paths := make([]string, 0, len(changesByPath))
	for path := range changesByPath {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	dirs := make([]string, 0, len(dirsByPath))
	for dir := range dirsByPath {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)

	events := make([]FileChangeEvent, 0, len(paths))
	for _, path := range paths {
		events = append(events, changesByPath[path])
	}

	if batchHandler != nil {
		batchHandler(FileChangeBatchEvent{
			RootID: sw.root.ID,
			Paths:  paths,
			Dirs:   dirs,
			Events: events,
		})
		return
	}
	if singleHandler != nil {
		for _, change := range events {
			singleHandler(change)
		}
	}
}

func parentDir(path string) string {
	clean := strings.Trim(filepath.ToSlash(path), "/")
	if clean == "" || clean == "." {
		return "."
	}
	idx := strings.LastIndex(clean, "/")
	if idx <= 0 {
		return "."
	}
	return clean[:idx]
}

func (sw *SharedFileWatcher) emitRelatedFile(change RelatedFileEvent) {
	sw.mu.RLock()
	handler := sw.onRelatedFile
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
