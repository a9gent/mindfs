package fs

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const MaxEditableFileBytes = 1 << 20

var (
	ErrFileConflict    = errors.New("file_edit_conflict")
	ErrFileNotEditable = errors.New("file_not_editable")
	ErrFileTooLarge    = errors.New("file_edit_too_large")
)

// Editing deliberately excludes the external-path fallback used for previews.
// Resolve symlinks before checking containment and locking the actual target.
func (r RootInfo) editablePath(path string) (string, string, error) {
	rel, err := r.NormalizePath(path)
	if err != nil {
		return "", "", err
	}
	abs, err := r.ResolvePath(rel)
	if err != nil {
		return "", "", err
	}
	abs, err = filepath.EvalSymlinks(abs)
	if err != nil {
		return "", "", err
	}
	root, err := filepath.EvalSymlinks(r.RootPath)
	if err != nil {
		return "", "", err
	}
	inside, err := filepath.Rel(root, abs)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return "", "", ErrFileNotEditable
	}
	return abs, rel, nil
}

func validEditableText(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	for _, b := range data {
		if b < 32 && b != '\t' && b != '\r' && b != '\n' && b != '\f' {
			return false
		}
	}
	return true
}

func textRevision(data []byte) string { return fmt.Sprintf("%x", sha256.Sum256(data)) }

func readEditableBytes(path string) ([]byte, os.FileInfo, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, ErrFileNotEditable
	}
	if info.Size() > MaxEditableFileBytes {
		return nil, nil, ErrFileTooLarge
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxEditableFileBytes+1))
	if err != nil {
		return nil, nil, err
	}
	if len(data) > MaxEditableFileBytes {
		return nil, nil, ErrFileTooLarge
	}
	if !validEditableText(data) {
		return nil, nil, ErrFileNotEditable
	}
	return data, info, nil
}

func (r RootInfo) ReadEditableFile(path string) (ReadResult, error) {
	abs, rel, err := r.editablePath(path)
	if err != nil {
		return ReadResult{}, err
	}
	lock := metaFileLock(abs)
	lock.Lock()
	defer lock.Unlock()
	data, info, err := readEditableBytes(abs)
	if err != nil {
		return ReadResult{}, err
	}
	ext := filepath.Ext(rel)
	return ReadResult{Root: r.ID, Path: rel, Name: filepath.Base(rel), Content: string(data),
		Encoding: "utf-8", Size: int64(len(data)), NextCursor: int64(len(data)), Ext: ext,
		Mime: mime.TypeByExtension(ext), MTime: info.ModTime().UTC(), Revision: textRevision(data)}, nil
}

func (r RootInfo) WriteEditableFile(path, content, baseRevision string) (ReadResult, error) {
	if baseRevision == "" {
		return ReadResult{}, errors.New("base_revision required")
	}
	data := []byte(content)
	if len(data) > MaxEditableFileBytes {
		return ReadResult{}, ErrFileTooLarge
	}
	if !validEditableText(data) {
		return ReadResult{}, ErrFileNotEditable
	}
	abs, rel, err := r.editablePath(path)
	if err != nil {
		return ReadResult{}, err
	}
	lock := metaFileLock(abs)
	lock.Lock()
	defer lock.Unlock()
	previous, info, err := readEditableBytes(abs)
	if err != nil {
		return ReadResult{}, err
	}
	if textRevision(previous) != baseRevision {
		return ReadResult{}, ErrFileConflict
	}
	// Rename alone only requires directory permissions; respect file permissions too.
	if info.Mode().Perm()&0222 == 0 {
		return ReadResult{}, os.ErrPermission
	}
	writable, err := os.OpenFile(abs, os.O_WRONLY, 0)
	if err != nil {
		return ReadResult{}, err
	}
	if err := writable.Close(); err != nil {
		return ReadResult{}, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(abs), ".mindfs-edit-*")
	if err != nil {
		return ReadResult{}, err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if _, err := tmp.Write(data); err != nil {
		return ReadResult{}, err
	}
	if err := tmp.Chmod(info.Mode().Perm()); err != nil {
		return ReadResult{}, err
	}
	if err := tmp.Sync(); err != nil {
		return ReadResult{}, err
	}
	committedInfo, err := tmp.Stat()
	if err != nil {
		return ReadResult{}, err
	}
	if err := tmp.Close(); err != nil {
		return ReadResult{}, err
	}
	// Recheck after preparing the replacement to narrow the external-writer race.
	latestPath, _, err := r.editablePath(path)
	if err != nil {
		return ReadResult{}, err
	}
	if latestPath != abs {
		return ReadResult{}, ErrFileConflict
	}
	latest, latestInfo, err := readEditableBytes(abs)
	if err != nil {
		return ReadResult{}, err
	}
	if !os.SameFile(info, latestInfo) || textRevision(latest) != baseRevision {
		return ReadResult{}, ErrFileConflict
	}
	if err := os.Rename(tmp.Name(), abs); err != nil {
		return ReadResult{}, err
	}
	// Return the committed snapshot, not a reread that could include an external edit.
	return ReadResult{Root: r.ID, Path: rel, Name: filepath.Base(rel), Content: content,
		Encoding: "utf-8", Size: int64(len(data)), NextCursor: int64(len(data)),
		Ext: filepath.Ext(rel), Mime: mime.TypeByExtension(filepath.Ext(rel)),
		MTime: committedInfo.ModTime().UTC(), Revision: textRevision(data)}, nil
}
