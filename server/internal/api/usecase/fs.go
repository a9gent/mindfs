package usecase

import (
	"context"
	"errors"
	"fmt"
	"io"
	stdmime "mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	"mindfs/server/internal/fs"
	"mindfs/server/internal/session"
)

type ListTreeInput struct {
	RootID string
	Dir    string
}

type ListTreeOutput struct {
	Entries []fs.Entry
}

type OpenFileRawInput struct {
	RootID string
	Path   string
}

type OpenFileRawOutput struct {
	File    *os.File
	Info    os.FileInfo
	RelPath string
}

type GetFileInfoInput struct {
	RootID string
	Path   string
}

type GetFileInfoOutput struct {
	Path  string
	Name  string
	Size  int64
	MTime time.Time
}

func (s *Service) ListTree(_ context.Context, in ListTreeInput) (ListTreeOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ListTreeOutput{}, err
	}
	s.ensureFileWatcher(in.RootID)
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return ListTreeOutput{}, err
	}
	dir := in.Dir
	if dir == "" || dir == "." {
		dir = "."
	} else {
		dir, err = root.NormalizePath(dir)
		if err != nil {
			return ListTreeOutput{}, err
		}
	}
	if err := root.ValidateRelativePath(dir); err != nil {
		return ListTreeOutput{}, err
	}
	entries, err := root.ListEntries(dir)
	if err != nil {
		return ListTreeOutput{}, err
	}
	return ListTreeOutput{Entries: entries}, nil
}

func (s *Service) OpenFileRaw(_ context.Context, in OpenFileRawInput) (OpenFileRawOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return OpenFileRawOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return OpenFileRawOutput{}, err
	}
	if in.Path == "" {
		return OpenFileRawOutput{}, errors.New("path required")
	}
	path, err := root.NormalizePath(in.Path)
	if err != nil {
		return OpenFileRawOutput{}, err
	}
	file, info, relPath, err := root.OpenFile(path)
	if err != nil {
		return OpenFileRawOutput{}, err
	}
	return OpenFileRawOutput{File: file, Info: info, RelPath: relPath}, nil
}

func (s *Service) GetFileInfo(_ context.Context, in GetFileInfoInput) (GetFileInfoOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return GetFileInfoOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return GetFileInfoOutput{}, err
	}
	if in.Path == "" {
		return GetFileInfoOutput{}, errors.New("path required")
	}
	path, err := root.NormalizePath(in.Path)
	if err != nil {
		return GetFileInfoOutput{}, err
	}
	info, relPath, err := root.StatFile(path)
	if err != nil {
		return GetFileInfoOutput{}, err
	}
	return GetFileInfoOutput{
		Path:  relPath,
		Name:  filepath.Base(relPath),
		Size:  info.Size(),
		MTime: info.ModTime().UTC(),
	}, nil
}

type UploadFile struct {
	Name        string
	ContentType string
	Reader      io.Reader
}

type SaveUploadedFilesInput struct {
	RootID string
	Dir    string
	Files  []UploadFile
}

type UploadedFile struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Mime string `json:"mime"`
	Size int64  `json:"size"`
}

type SaveUploadedFilesOutput struct {
	Files []UploadedFile
}

func (s *Service) SaveUploadedFiles(_ context.Context, in SaveUploadedFilesInput) (SaveUploadedFilesOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return SaveUploadedFilesOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return SaveUploadedFilesOutput{}, err
	}
	if len(in.Files) == 0 {
		return SaveUploadedFilesOutput{}, errors.New("files required")
	}

	destDir, destAbs, err := resolveUploadDir(root, in.Dir)
	if err != nil {
		return SaveUploadedFilesOutput{}, err
	}
	if err := os.MkdirAll(destAbs, 0o755); err != nil {
		return SaveUploadedFilesOutput{}, err
	}

	saved := make([]UploadedFile, 0, len(in.Files))
	for _, file := range in.Files {
		result, err := saveUploadFile(destDir, destAbs, file)
		if err != nil {
			return SaveUploadedFilesOutput{}, err
		}
		saved = append(saved, result)
	}
	return SaveUploadedFilesOutput{Files: saved}, nil
}

type ReadFileInput struct {
	RootID   string
	Path     string
	MaxBytes int64
	Cursor   int64
	ReadMode string
}

type ReadFileOutput struct {
	File fs.ReadResult
}

func (s *Service) ReadFile(ctx context.Context, in ReadFileInput) (ReadFileOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ReadFileOutput{}, err
	}
	s.ensureFileWatcher(in.RootID)
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return ReadFileOutput{}, err
	}
	if in.Path == "" {
		return ReadFileOutput{}, errors.New("path required")
	}
	path, err := root.NormalizePath(in.Path)
	if err != nil {
		return ReadFileOutput{}, err
	}
	result, err := root.ReadFile(path, in.MaxBytes, in.Cursor, in.ReadMode)
	if err != nil {
		return ReadFileOutput{}, err
	}
	meta, err := root.GetFileMeta(path)
	if err != nil {
		return ReadFileOutput{}, err
	}
	meta = fillFileMetaSessionInfo(ctx, s, in.RootID, meta)
	result.Root = root.ID
	result.FileMeta = meta
	return ReadFileOutput{File: result}, nil
}

func resolveUploadDir(root fs.RootInfo, dir string) (string, string, error) {
	destDir := strings.TrimSpace(dir)
	if destDir == "" {
		destDir = defaultUploadDir()
	} else {
		var err error
		destDir, err = root.NormalizePath(destDir)
		if err != nil {
			return "", "", err
		}
	}
	if err := root.ValidateRelativePath(destDir); err != nil {
		return "", "", err
	}
	rootDir, err := root.RootDir()
	if err != nil {
		return "", "", err
	}
	destAbs := filepath.Join(rootDir, filepath.FromSlash(destDir))
	return destDir, destAbs, nil
}

func defaultUploadDir() string {
	return filepath.ToSlash(filepath.Join(".mindfs", "upload", time.Now().Format("2006-01-02")))
}

func saveUploadFile(destDir, destAbs string, file UploadFile) (UploadedFile, error) {
	if file.Reader == nil {
		return UploadedFile{}, errors.New("file reader required")
	}
	name := sanitizeUploadName(file.Name)
	if name == "" {
		return UploadedFile{}, errors.New("file name required")
	}

	for index := 0; ; index++ {
		candidateName := disambiguateUploadName(name, index)
		relPath := joinUploadPath(destDir, candidateName)
		absPath := filepath.Join(destAbs, candidateName)

		handle, err := os.OpenFile(absPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			if os.IsExist(err) {
				continue
			}
			return UploadedFile{}, err
		}

		size, copyErr := io.Copy(handle, file.Reader)
		closeErr := handle.Close()
		if copyErr != nil {
			_ = os.Remove(absPath)
			return UploadedFile{}, copyErr
		}
		if closeErr != nil {
			_ = os.Remove(absPath)
			return UploadedFile{}, closeErr
		}

		return UploadedFile{
			Path: relPath,
			Name: candidateName,
			Mime: uploadMimeType(candidateName, file.ContentType),
			Size: size,
		}, nil
	}
}

func sanitizeUploadName(name string) string {
	clean := strings.TrimSpace(name)
	if clean == "" {
		return ""
	}
	clean = filepath.Base(clean)
	if clean == "." || clean == string(filepath.Separator) {
		return ""
	}
	return clean
}

func disambiguateUploadName(name string, index int) string {
	if index <= 0 {
		return name
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	return fmt.Sprintf("%s (%d)%s", base, index, ext)
}

func joinUploadPath(dir, name string) string {
	if dir == "." || dir == "" {
		return name
	}
	return filepath.ToSlash(filepath.Join(dir, name))
}

func uploadMimeType(name, contentType string) string {
	if contentType != "" {
		if mediaType, _, err := stdmime.ParseMediaType(contentType); err == nil && mediaType != "" {
			return mediaType
		}
	}
	if mimeType := stdmime.TypeByExtension(strings.ToLower(filepath.Ext(name))); mimeType != "" {
		return mimeType
	}
	return "application/octet-stream"
}

func fillFileMetaSessionInfo(ctx context.Context, s *Service, rootID string, meta []fs.FileMetaEntry) []fs.FileMetaEntry {
	if len(meta) == 0 {
		return meta
	}
	manager, err := s.Registry.GetSessionManager(rootID)
	if err != nil || manager == nil {
		return meta
	}
	for i := range meta {
		if meta[i].SourceSession == "" {
			continue
		}
		if meta[i].SessionName != "" && meta[i].Agent != "" {
			continue
		}
		sess, err := manager.Get(ctx, meta[i].SourceSession, 0)
		if err != nil || sess == nil {
			continue
		}
		if meta[i].SessionName == "" {
			meta[i].SessionName = sess.Name
		}
		if meta[i].Agent == "" {
			meta[i].Agent = session.InferAgentFromSession(sess)
		}
	}
	return meta
}

type GetFileMetaInput struct {
	RootID string
	Path   string
}

type GetFileMetaOutput struct {
	Meta []fs.FileMetaEntry
}

func (s *Service) GetFileMeta(_ context.Context, in GetFileMetaInput) (GetFileMetaOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return GetFileMetaOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return GetFileMetaOutput{}, err
	}
	if in.Path == "" {
		return GetFileMetaOutput{}, errors.New("path required")
	}
	path, err := root.NormalizePath(in.Path)
	if err != nil {
		return GetFileMetaOutput{}, err
	}
	meta, err := root.GetFileMeta(path)
	if err != nil {
		return GetFileMetaOutput{}, err
	}
	return GetFileMetaOutput{Meta: meta}, nil
}

type ListManagedDirsOutput struct {
	Dirs []fs.RootInfo
}

func (s *Service) ListManagedDirs(_ context.Context) (ListManagedDirsOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ListManagedDirsOutput{}, err
	}
	return ListManagedDirsOutput{Dirs: s.Registry.ListRoots()}, nil
}

type AddManagedDirInput struct {
	Path   string
	Create bool
}

type AddManagedDirOutput struct {
	Dir fs.RootInfo
}

func (s *Service) AddManagedDir(_ context.Context, in AddManagedDirInput) (AddManagedDirOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return AddManagedDirOutput{}, err
	}
	if in.Path == "" {
		return AddManagedDirOutput{}, errors.New("path required")
	}
	abs, err := resolveManagedDirPath(s.Registry, in.Path, in.Create)
	if err != nil {
		return AddManagedDirOutput{}, err
	}
	name := filepath.Base(abs)
	if _, err := fs.NewRootInfo(name, name, abs).EnsureMetaDir(); err != nil {
		return AddManagedDirOutput{}, err
	}
	dir, err := s.Registry.UpsertRoot(abs)
	if err != nil {
		return AddManagedDirOutput{}, err
	}
	return AddManagedDirOutput{Dir: dir}, nil
}

func resolveManagedDirPath(registry Registry, raw string, create bool) (string, error) {
	if create {
		return createManagedDir(registry, raw)
	}
	if !filepath.IsAbs(raw) {
		return "", errors.New("path must be absolute")
	}
	abs := filepath.Clean(raw)
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return "", errors.New("path must be a directory")
	}
	return abs, nil
}

func createManagedDir(registry Registry, name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", errors.New("path required")
	}
	if trimmed == "." || trimmed == ".." {
		return "", errors.New("invalid root name")
	}
	if strings.Contains(trimmed, "/") || strings.Contains(trimmed, "\\") {
		return "", errors.New("root name must not contain path separators")
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	baseDir := filepath.Join(homeDir, "mindfs")
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		return "", err
	}

	rootPath := filepath.Join(baseDir, trimmed)
	cleanRootPath := filepath.Clean(rootPath)
	for _, existing := range registry.ListRoots() {
		existingPath := filepath.Clean(existing.RootPath)
		if existing.ID == trimmed && existingPath != cleanRootPath {
			return "", errors.New("root name already exists")
		}
		if existingPath == cleanRootPath {
			return "", errors.New("root already exists")
		}
	}

	if info, err := os.Stat(rootPath); err == nil {
		if info.IsDir() {
			return cleanRootPath, nil
		}
		return "", errors.New("root path already exists and is not a directory")
	} else if !os.IsNotExist(err) {
		return "", err
	}

	if err := os.Mkdir(rootPath, 0o755); err != nil {
		return "", err
	}
	return cleanRootPath, nil
}

type RemoveManagedDirInput struct {
	Path string
}

type RemoveManagedDirOutput struct {
	Dir fs.RootInfo
}

func (s *Service) RemoveManagedDir(_ context.Context, in RemoveManagedDirInput) (RemoveManagedDirOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return RemoveManagedDirOutput{}, err
	}
	if in.Path == "" {
		return RemoveManagedDirOutput{}, errors.New("path required")
	}
	if !filepath.IsAbs(in.Path) {
		return RemoveManagedDirOutput{}, errors.New("path must be absolute")
	}
	dir, err := s.Registry.RemoveRoot(filepath.Clean(in.Path))
	if err != nil {
		return RemoveManagedDirOutput{}, err
	}
	return RemoveManagedDirOutput{Dir: dir}, nil
}

func (s *Service) ensureFileWatcher(rootID string) {
	if strings.TrimSpace(rootID) == "" {
		return
	}
	manager, err := s.Registry.GetSessionManager(rootID)
	if err != nil || manager == nil {
		return
	}
	watcher, err := s.Registry.GetFileWatcher(rootID, manager)
	if err != nil || watcher == nil {
		return
	}
}
