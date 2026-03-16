package fs

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
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
	root, err := r.rootDir()
	if err != nil {
		return "", err
	}
	path = strings.SplitN(path, "#", 2)[0]
	if path == "" {
		return "", errors.New("path required")
	}
	cleanPath := filepath.Clean(path)
	if filepath.IsAbs(cleanPath) {
		return r.relativeFromAbsolute(cleanPath)
	}
	rootSlash := filepath.ToSlash(root)
	pathSlash := filepath.ToSlash(cleanPath)
	rootTrimmed := strings.TrimPrefix(rootSlash, "/")
	if rootTrimmed != "" && (pathSlash == rootTrimmed || strings.HasPrefix(pathSlash, rootTrimmed+"/")) {
		return r.relativeFromAbsolute(string(filepath.Separator) + filepath.FromSlash(pathSlash))
	}
	resolved, err := r.resolveRelativePath(cleanPath)
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
	Size  int64  `json:"size"`
	MTime string `json:"mtime"`
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
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		result = append(result, Entry{
			Name:  name,
			Path:  relPath,
			IsDir: entry.IsDir(),
			Size:  info.Size(),
			MTime: info.ModTime().UTC().Format(time.RFC3339Nano),
		})
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
	Path       string          `json:"path"`
	Name       string          `json:"name"`
	Content    string          `json:"content"`
	Encoding   string          `json:"encoding"`
	Truncated  bool            `json:"truncated"`
	NextCursor int64           `json:"next_cursor"`
	Size       int64           `json:"size"`
	Ext        string          `json:"ext"`
	Mime       string          `json:"mime"`
	MTime      time.Time       `json:"mtime"`
	Root       string          `json:"root,omitempty"`
	FileMeta   []FileMetaEntry `json:"file_meta,omitempty"`
}

func (r RootInfo) ReadFile(pathRel string, maxBytes int64, cursor int64, readMode string) (ReadResult, error) {
	if cursor < 0 {
		return ReadResult{}, errors.New("cursor must be non-negative")
	}
	if readMode == "" {
		readMode = "incremental"
	}
	if readMode != "full" && readMode != "incremental" {
		return ReadResult{}, errors.New("invalid read mode")
	}
	if readMode == "incremental" && maxBytes <= 0 {
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
	ext := filepath.Ext(resolved)
	bom := readFileBOM(file)
	readOffset := cursor
	if cursor > 0 {
		readOffset = alignReadOffsetForDecoding(file, info, ext, cursor, bom)
		if _, err := file.Seek(readOffset, io.SeekStart); err != nil {
			return ReadResult{}, err
		}
	}

	var (
		buf []byte
		n   int
	)
	if readMode == "full" {
		buf, err = io.ReadAll(file)
		if err != nil {
			return ReadResult{}, err
		}
		n = len(buf)
	} else {
		buf = make([]byte, maxBytes)
		n, err = io.ReadFull(file, buf)
		if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
			return ReadResult{}, err
		}
		buf = buf[:n]
	}
	buf = trimTailForDecoding(buf, ext, bom)
	n = len(buf)
	truncated := readMode != "full" && readOffset+int64(n) < info.Size()
	encoding := "utf-8"
	content := string(buf)
	if !utf8.Valid(buf) {
		if decoded, detectedEncoding, ok := tryDecodeText(buf, ext); ok {
			encoding = detectedEncoding
			content = decoded
		} else {
			encoding = "binary"
			content = ""
		}
	}
	mimeType := mime.TypeByExtension(ext)
	return ReadResult{
		Path:       relPath,
		Name:       filepath.Base(resolved),
		Content:    content,
		Encoding:   encoding,
		Truncated:  truncated,
		NextCursor: readOffset + int64(n),
		Size:       info.Size(),
		Ext:        ext,
		Mime:       mimeType,
		MTime:      info.ModTime().UTC(),
	}, nil
}

func alignReadOffsetForDecoding(file *os.File, info os.FileInfo, ext string, offset int64, bom string) int64 {
	if offset <= 0 {
		return 0
	}
	if !isTextLikeExt(ext) {
		return offset
	}
	if offset >= info.Size() {
		return info.Size()
	}
	aligned := offset
	switch bom {
	case "utf16le", "utf16be":
		base := int64(2)
		if aligned < base {
			aligned = base
		}
		if (aligned-base)%2 != 0 {
			aligned--
		}
		if aligned < base {
			aligned = base
		}
		return aligned
	case "utf8bom":
		if aligned < 3 {
			aligned = 3
		}
	}
	// UTF-8 safety: if starts from a continuation byte, advance to next rune start.
	// This avoids malformed prefix when cursor lands in the middle of a multibyte rune.
	var probe [4]byte
	n, err := file.ReadAt(probe[:], aligned)
	if err != nil && err != io.EOF {
		return aligned
	}
	for i := 0; i < n; i++ {
		if !isUTF8ContinuationByte(probe[i]) {
			aligned += int64(i)
			break
		}
	}
	return alignReadOffsetForGB18030(file, info.Size(), aligned)
}

func isTextLikeExt(ext string) bool {
	switch strings.ToLower(ext) {
	case ".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".csv", ".log":
		return true
	default:
		return false
	}
}

func readFileBOM(file *os.File) string {
	var hdr [3]byte
	n, err := file.ReadAt(hdr[:], 0)
	if err != nil && err != io.EOF {
		return ""
	}
	if n >= 2 && hdr[0] == 0xFF && hdr[1] == 0xFE {
		return "utf16le"
	}
	if n >= 2 && hdr[0] == 0xFE && hdr[1] == 0xFF {
		return "utf16be"
	}
	if n >= 3 && hdr[0] == 0xEF && hdr[1] == 0xBB && hdr[2] == 0xBF {
		return "utf8bom"
	}
	return ""
}

func isUTF8ContinuationByte(b byte) bool {
	return b&0xC0 == 0x80
}

func alignReadOffsetForGB18030(file *os.File, fileSize int64, offset int64) int64 {
	if offset >= fileSize {
		return fileSize
	}
	// If offset lands in the middle of a GB18030 rune, advance to next valid start.
	// Max rune width is 4 bytes, so scanning forward up to 3 bytes is sufficient.
	for shift := int64(0); shift <= 3; shift++ {
		candidate := offset + shift
		if candidate >= fileSize {
			return fileSize
		}
		var probe [4]byte
		n, err := file.ReadAt(probe[:], candidate)
		if err != nil && err != io.EOF {
			return offset
		}
		if n <= 0 {
			return candidate
		}
		runeLen, incomplete, valid := parseGB18030Rune(probe[:n])
		if valid && runeLen > 0 {
			return candidate
		}
		if incomplete {
			// Near EOF, treat as aligned to avoid over-shifting.
			return candidate
		}
	}
	return offset
}

func trimTailForGB18030(buf []byte) []byte {
	i := 0
	for i < len(buf) {
		runeLen, incomplete, valid := parseGB18030Rune(buf[i:])
		if incomplete {
			return buf[:i]
		}
		if !valid || runeLen <= 0 {
			// Not a clean GB18030 stream; leave buffer unchanged.
			return buf
		}
		i += runeLen
	}
	return buf
}

func parseGB18030Rune(buf []byte) (runeLen int, incomplete bool, valid bool) {
	if len(buf) == 0 {
		return 0, true, false
	}
	b0 := buf[0]
	if b0 <= 0x7F {
		return 1, false, true
	}
	if b0 < 0x81 || b0 > 0xFE {
		return 0, false, false
	}
	if len(buf) < 2 {
		return 0, true, false
	}
	b1 := buf[1]
	// Four-byte sequence: 81-FE 30-39 81-FE 30-39
	if b1 >= 0x30 && b1 <= 0x39 {
		if len(buf) < 4 {
			return 0, true, false
		}
		b2 := buf[2]
		b3 := buf[3]
		if b2 >= 0x81 && b2 <= 0xFE && b3 >= 0x30 && b3 <= 0x39 {
			return 4, false, true
		}
		return 0, false, false
	}
	// Two-byte sequence: 81-FE 40-FE (excluding 7F)
	if b1 >= 0x40 && b1 <= 0xFE && b1 != 0x7F {
		return 2, false, true
	}
	return 0, false, false
}

func trimTailForDecoding(buf []byte, ext string, bom string) []byte {
	if len(buf) == 0 || !isTextLikeExt(ext) {
		return buf
	}
	// UTF-16 files: enforce 2-byte boundary at tail.
	if bom == "utf16le" || bom == "utf16be" {
		if len(buf)%2 == 1 {
			return buf[:len(buf)-1]
		}
		return buf
	}
	// If already valid UTF-8, no tail trim is needed.
	if utf8.Valid(buf) {
		return buf
	}
	// GB18030 tail safety: trim only when the tail is an incomplete rune.
	if trimmed := trimTailForGB18030(buf); len(trimmed) != len(buf) {
		return trimmed
	}
	// UTF-8 tail safety: remove incomplete trailing rune bytes.
	// Try up to 4 bytes (max UTF-8 rune length) for a valid prefix.
	for cut := 1; cut <= 4 && cut < len(buf); cut++ {
		candidate := buf[:len(buf)-cut]
		if utf8.Valid(candidate) {
			return candidate
		}
	}
	return buf
}

func tryDecodeText(buf []byte, ext string) (string, string, bool) {
	// Only attempt legacy decoding for common text file types.
	if !isTextLikeExt(ext) {
		return "", "", false
	}

	if decoded, ok := decodeUTF16(buf); ok {
		return decoded, "utf-16", true
	}

	decoded, err := simplifiedchinese.GB18030.NewDecoder().Bytes(buf)
	if err != nil {
		return "", "", false
	}
	decoded = bytes.Trim(decoded, "\x00")
	if len(decoded) == 0 {
		return "", "", false
	}
	if !utf8.Valid(decoded) {
		return "", "", false
	}
	return string(decoded), "gb18030", true
}

func decodeUTF16(buf []byte) (string, bool) {
	if len(buf) < 2 {
		return "", false
	}
	// BOM detection
	if buf[0] == 0xFF && buf[1] == 0xFE {
		return decodeUTF16Endian(buf[2:], binary.LittleEndian)
	}
	if buf[0] == 0xFE && buf[1] == 0xFF {
		return decodeUTF16Endian(buf[2:], binary.BigEndian)
	}
	// Heuristic detection when BOM is missing.
	var evenZero, oddZero int
	limit := len(buf)
	if limit > 4096 {
		limit = 4096
	}
	for i := 0; i < limit; i++ {
		if buf[i] != 0 {
			continue
		}
		if i%2 == 0 {
			evenZero++
		} else {
			oddZero++
		}
	}
	// ASCII-like UTF-16LE usually has many zero bytes at odd positions.
	if oddZero > evenZero*4 && oddZero > 32 {
		if s, ok := decodeUTF16Endian(buf, binary.LittleEndian); ok {
			return s, true
		}
	}
	// ASCII-like UTF-16BE usually has many zero bytes at even positions.
	if evenZero > oddZero*4 && evenZero > 32 {
		if s, ok := decodeUTF16Endian(buf, binary.BigEndian); ok {
			return s, true
		}
	}
	return "", false
}

func decodeUTF16Endian(buf []byte, order binary.ByteOrder) (string, bool) {
	if len(buf) < 2 {
		return "", false
	}
	if len(buf)%2 == 1 {
		buf = buf[:len(buf)-1]
	}
	u16 := make([]uint16, 0, len(buf)/2)
	for i := 0; i+1 < len(buf); i += 2 {
		u16 = append(u16, order.Uint16(buf[i:i+2]))
	}
	if len(u16) == 0 {
		return "", false
	}
	s := string(utf16.Decode(u16))
	s = strings.Trim(s, "\x00")
	if s == "" {
		return "", false
	}
	return s, true
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

func (r RootInfo) StatFile(pathRel string) (os.FileInfo, string, error) {
	resolved, err := r.resolveRelativePath(pathRel)
	if err != nil {
		return nil, "", err
	}
	relPath, err := r.relativeFromAbsolute(resolved)
	if err != nil {
		return nil, "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, "", err
	}
	if info.IsDir() {
		return nil, "", errors.New("path is a directory")
	}
	return info, relPath, nil
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
