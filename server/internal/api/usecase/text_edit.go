package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"mindfs/server/internal/fs"
)

type FileOperationInput struct {
	Root        string `json:"root"`
	Path        string `json:"path"`
	Action      string `json:"action"`
	Name        string `json:"name"`
	Destination string `json:"destination"`
}

var fileOperationMu sync.Mutex

func (s *Service) OperateFile(in FileOperationInput) error {
	fileOperationMu.Lock()
	defer fileOperationMu.Unlock()
	if err := s.ensureRegistry(); err != nil {
		return err
	}
	root, err := s.Registry.GetRoot(in.Root)
	if err != nil {
		return err
	}
	// Mutation paths are literal file names, not navigation locations (#line).
	rel := filepath.Clean(in.Path)
	if filepath.IsAbs(rel) {
		rel, err = filepath.Rel(root.RootPath, rel)
		if err != nil {
			return err
		}
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return errors.New("path outside root")
	}
	if rel == "." || rel == "" {
		return errors.New("cannot modify project root")
	}
	// Resolve the parent only: operating on a symlink must affect the link itself.
	base, err := root.ResolvePath(".")
	if err != nil {
		return err
	}
	parent := filepath.Join(base, filepath.Dir(rel))
	if strings.HasPrefix(filepath.ToSlash(rel), ".mindfs/") {
		parent = filepath.Join(root.MetaDir(), filepath.Dir(strings.TrimPrefix(filepath.ToSlash(rel), ".mindfs/")))
	}
	parent, err = filepath.EvalSymlinks(parent)
	if err != nil {
		return err
	}
	source := filepath.Join(parent, filepath.Base(rel))
	for _, managed := range s.Registry.ListRoots() {
		managedPath, resolveErr := filepath.EvalSymlinks(managed.RootPath)
		if resolveErr == nil && (managedPath == source || strings.HasPrefix(managedPath, source+string(filepath.Separator))) {
			return errors.New("cannot modify a project root or its ancestor")
		}
	}
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if in.Action == "delete" {
		return os.RemoveAll(source)
	}
	var destination string
	switch in.Action {
	case "rename":
		if strings.TrimSpace(in.Name) == "" || in.Name == "." || in.Name == ".." || strings.ContainsAny(in.Name, "/\\\x00") {
			return errors.New("invalid name")
		}
		destination = filepath.Join(parent, in.Name)
	case "move":
		if !filepath.IsAbs(in.Destination) {
			return errors.New("absolute destination directory required")
		}
		target, err := filepath.EvalSymlinks(in.Destination)
		if err != nil {
			return err
		}
		stat, err := os.Stat(target)
		if err != nil {
			return err
		}
		if !stat.IsDir() {
			return errors.New("destination is not a directory")
		}
		if info.IsDir() && (target == source || strings.HasPrefix(target, source+string(filepath.Separator))) {
			return errors.New("cannot move a directory into itself")
		}
		destination = filepath.Join(target, filepath.Base(source))
	default:
		return errors.New("unsupported file operation")
	}
	if source == destination {
		return errors.New("source and destination are identical")
	}
	if _, err := os.Lstat(destination); err == nil {
		return os.ErrExist
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.Rename(source, destination)
}

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
