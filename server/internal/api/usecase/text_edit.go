package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"mindfs/server/internal/fs"
)

func (s *Service) ReadEditableFile(ctx context.Context, rootID, path string) (fs.ReadResult, error) {
	if err := s.ensureRegistry(); err != nil {
		return fs.ReadResult{}, err
	}
	root, err := s.Registry.GetRoot(rootID)
	if err != nil {
		return fs.ReadResult{}, err
	}
	file, err := root.ReadEditableFile(path)
	if err != nil {
		return fs.ReadResult{}, err
	}
	s.ensureFileWatcher(rootID, parentDir(file.Path))
	meta, err := root.GetFileMeta(file.Path)
	if err != nil {
		return fs.ReadResult{}, err
	}
	file.FileMeta = fillFileMetaSessionInfo(ctx, s, rootID, meta)
	return file, nil
}

func (s *Service) WriteEditableFile(rootID, path, content, revision string) (fs.ReadResult, error) {
	if err := s.ensureRegistry(); err != nil {
		return fs.ReadResult{}, err
	}
	root, err := s.Registry.GetRoot(rootID)
	if err != nil {
		return fs.ReadResult{}, err
	}
	return root.WriteEditableFile(path, content, revision)
}

// CreateBlankFile creates exactly the requested name without replacing existing entries.
func (s *Service) CreateBlankFile(rootID, dir, name string) (string, error) {
	if strings.TrimSpace(name) == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return "", errors.New("invalid file name")
	}
	if err := s.ensureRegistry(); err != nil {
		return "", err
	}
	root, err := s.Registry.GetRoot(rootID)
	if err != nil {
		return "", err
	}
	if dir == "" {
		dir = "."
	}
	dir, err = root.NormalizePath(dir)
	if err != nil {
		return "", err
	}
	absDir, err := root.ResolvePath(dir)
	if err != nil {
		return "", err
	}
	handle, err := os.OpenFile(filepath.Join(absDir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return "", err
	}
	if err := handle.Close(); err != nil {
		return "", err
	}
	return filepath.ToSlash(filepath.Join(dir, name)), nil
}
