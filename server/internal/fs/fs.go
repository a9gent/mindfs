package fs

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	metaDirName         = ".mindfs"
	stateFileName       = "state.json"
	defaultMaxReadBytes = 64 * 1024
)

type RootInfo struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	RootPath  string    `json:"root_path"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func NewRootInfo(id, name, rootPath string) RootInfo {
	if id == "" {
		id = filepath.Base(rootPath)
	}
	if name == "" {
		name = id
	}
	return RootInfo{ID: id, Name: name, RootPath: rootPath}
}

func (r RootInfo) rootDir() (string, error) {
	if r.RootPath == "" {
		return "", errors.New("root required")
	}
	return filepath.Clean(r.RootPath), nil
}

func (r RootInfo) resolveRelativePath(relPath string) (string, error) {
	if relPath == "" {
		relPath = "."
	}
	if filepath.IsAbs(relPath) {
		return "", errors.New("absolute path not allowed")
	}
	root, err := r.rootDir()
	if err != nil {
		return "", err
	}
	clean := filepath.Clean(filepath.Join(root, relPath))
	rel, err := filepath.Rel(root, clean)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", errors.New("path outside root")
	}
	return clean, nil
}

func (r RootInfo) relativeFromAbsolute(absPath string) (string, error) {
	root, err := r.rootDir()
	if err != nil {
		return "", err
	}
	clean := filepath.Clean(absPath)
	rel, err := filepath.Rel(root, clean)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", errors.New("path outside root")
	}
	return filepath.ToSlash(rel), nil
}

// RootDir returns the absolute root directory path.
func (r RootInfo) RootDir() (string, error) {
	return r.rootDir()
}

// ValidateRelativePath validates that relPath is inside this root.
func (r RootInfo) ValidateRelativePath(relPath string) error {
	_, err := r.resolveRelativePath(relPath)
	return err
}

// NormalizePath returns a slash-style path relative to the root.
// Input may be relative to root or an absolute path inside root.
func (r RootInfo) NormalizePath(path string) (string, error) {
	if path == "" {
		return "", errors.New("path required")
	}
	if filepath.IsAbs(path) {
		return r.relativeFromAbsolute(path)
	}
	resolved, err := r.resolveRelativePath(path)
	if err != nil {
		return "", err
	}
	return r.relativeFromAbsolute(resolved)
}

func (r RootInfo) MetaDir() string {
	rootAbs, err := r.rootDir()
	if err != nil {
		return ""
	}
	return filepath.Join(rootAbs, metaDirName)
}

func (r RootInfo) EnsureMetaDir() (string, error) {
	metaDir := r.MetaDir()
	if metaDir == "" {
		return "", errors.New("root required")
	}
	if err := os.MkdirAll(metaDir, 0o755); err != nil {
		return "", err
	}
	return metaDir, nil
}

func (r RootInfo) resolveMetaPath(path string) (string, error) {
	if path == "" {
		path = "."
	}
	rootRel := filepath.ToSlash(filepath.Join(metaDirName, filepath.Clean(path)))
	return r.resolveRelativePath(rootRel)
}

func (r RootInfo) ListMetaEntries(path string) ([]os.DirEntry, error) {
	resolved, err := r.resolveMetaPath(path)
	if err != nil {
		return nil, err
	}
	return os.ReadDir(resolved)
}

func (r RootInfo) OpenMetaFile(path string) (*os.File, error) {
	resolved, err := r.resolveMetaPath(path)
	if err != nil {
		return nil, err
	}
	return os.Open(resolved)
}

func (r RootInfo) OpenMetaFileAppend(path string) (*os.File, error) {
	resolved, err := r.resolveMetaPath(path)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
		return nil, err
	}
	return os.OpenFile(resolved, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
}

func (r RootInfo) ReadMetaFile(path string) ([]byte, error) {
	resolved, err := r.resolveMetaPath(path)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(resolved)
}

func (r RootInfo) WriteMetaFile(path string, data []byte) error {
	resolved, err := r.resolveMetaPath(path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
		return err
	}
	return os.WriteFile(resolved, data, 0o644)
}

// Entry represents a filesystem entry for UI listings.
type Entry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"is_dir"`
}

func (r RootInfo) ListEntries(dirRelPath string) ([]Entry, error) {
	dirAbs, err := r.resolveRelativePath(dirRelPath)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dirAbs)
	if err != nil {
		return nil, err
	}
	result := make([]Entry, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		absPath := filepath.Join(dirAbs, name)
		relPath, err := r.relativeFromAbsolute(absPath)
		if err != nil {
			return nil, err
		}
		result = append(result, Entry{Name: name, Path: relPath, IsDir: entry.IsDir()})
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return result[i].Name < result[j].Name
	})
	return result, nil
}

type ReadResult struct {
	Path      string          `json:"path"`
	Name      string          `json:"name"`
	Content   string          `json:"content"`
	Encoding  string          `json:"encoding"`
	Truncated bool            `json:"truncated"`
	Size      int64           `json:"size"`
	Ext       string          `json:"ext"`
	Mime      string          `json:"mime"`
	Root      string          `json:"root,omitempty"`
	FileMeta  []FileMetaEntry `json:"file_meta,omitempty"`
}

func (r RootInfo) ReadFile(pathRel string, maxBytes int64) (ReadResult, error) {
	if maxBytes <= 0 {
		maxBytes = defaultMaxReadBytes
	}
	resolved, err := r.resolveRelativePath(pathRel)
	if err != nil {
		return ReadResult{}, err
	}
	relPath, err := r.relativeFromAbsolute(resolved)
	if err != nil {
		return ReadResult{}, err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return ReadResult{}, err
	}
	if info.IsDir() {
		return ReadResult{}, errors.New("path is a directory")
	}
	file, err := os.Open(resolved)
	if err != nil {
		return ReadResult{}, err
	}
	defer file.Close()

	buf := make([]byte, maxBytes)
	n, err := io.ReadFull(file, buf)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return ReadResult{}, err
	}
	buf = buf[:n]
	truncated := info.Size() > int64(n)
	encoding := "utf-8"
	content := string(buf)
	if !utf8.Valid(buf) {
		encoding = "binary"
		content = ""
	}
	ext := filepath.Ext(resolved)
	mimeType := mime.TypeByExtension(ext)
	return ReadResult{
		Path:      relPath,
		Name:      filepath.Base(resolved),
		Content:   content,
		Encoding:  encoding,
		Truncated: truncated,
		Size:      info.Size(),
		Ext:       ext,
		Mime:      mimeType,
	}, nil
}

func (r RootInfo) OpenFile(pathRel string) (*os.File, os.FileInfo, string, error) {
	resolved, err := r.resolveRelativePath(pathRel)
	if err != nil {
		return nil, nil, "", err
	}
	relPath, err := r.relativeFromAbsolute(resolved)
	if err != nil {
		return nil, nil, "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, nil, "", err
	}
	if info.IsDir() {
		return nil, nil, "", errors.New("path is a directory")
	}
	file, err := os.Open(resolved)
	if err != nil {
		return nil, nil, "", err
	}
	return file, info, relPath, nil
}

// State captures cursor/position info for a managed directory.
type State struct {
	Cursor   string `json:"cursor,omitempty"`
	Position int    `json:"position,omitempty"`
}

func (r RootInfo) LoadState() (State, error) {
	payload, err := r.ReadMetaFile(stateFileName)
	if err != nil {
		if os.IsNotExist(err) {
			return State{}, nil
		}
		return State{}, err
	}
	var state State
	if err := json.Unmarshal(payload, &state); err != nil {
		return State{}, err
	}
	return state, nil
}

type FileMetaEntry struct {
	SourceSession string    `json:"source_session"`
	SessionName   string    `json:"session_name,omitempty"`
	Agent         string    `json:"agent,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at,omitempty"`
	CreatedBy     string    `json:"created_by"`
}

type FileMeta map[string][]FileMetaEntry

func (r RootInfo) LoadFileMeta() (FileMeta, error) {
	payload, err := r.ReadMetaFile("file-meta.json")
	if err != nil {
		if os.IsNotExist(err) {
			return FileMeta{}, nil
		}
		return nil, err
	}
	var meta FileMeta
	if err := json.Unmarshal(payload, &meta); err == nil {
		if meta == nil {
			meta = FileMeta{}
		}
		return meta, nil
	}

	// Backward compatibility: old format was map[path]FileMetaEntry.
	var legacy map[string]FileMetaEntry
	if err := json.Unmarshal(payload, &legacy); err != nil {
		return nil, err
	}
	meta = FileMeta{}
	for path, entry := range legacy {
		meta[path] = []FileMetaEntry{entry}
	}
	return meta, nil
}

func (r RootInfo) SaveFileMeta(meta FileMeta) error {
	if meta == nil {
		meta = FileMeta{}
	}
	payload, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return r.WriteMetaFile("file-meta.json", payload)
}

func (r RootInfo) UpdateFileMeta(relativePath, sessionKey, createdBy string) error {
	if relativePath == "" {
		return errors.New("path required")
	}
	meta, err := r.LoadFileMeta()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	entries := meta[relativePath]
	updated := false
	for i := range entries {
		if entries[i].SourceSession == sessionKey {
			entries[i].UpdatedAt = now
			if entries[i].CreatedBy == "" {
				entries[i].CreatedBy = createdBy
			}
			updated = true
			break
		}
	}
	if !updated {
		entries = append(entries, FileMetaEntry{
			SourceSession: sessionKey,
			CreatedAt:     now,
			UpdatedAt:     now,
			CreatedBy:     createdBy,
		})
	}
	meta[relativePath] = entries
	return r.SaveFileMeta(meta)
}

func (r RootInfo) GetFileMeta(relativePath string) ([]FileMetaEntry, error) {
	meta, err := r.LoadFileMeta()
	if err != nil {
		return nil, err
	}
	if entry, ok := meta[relativePath]; ok {
		return entry, nil
	}
	return nil, nil
}
