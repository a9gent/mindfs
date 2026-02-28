package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"mindfs/server/internal/fs"
	"mindfs/server/internal/router"
	"mindfs/server/internal/session"
)

type ListTreeInput struct {
	RootID string
	Dir    string
}

type ListTreeOutput struct {
	Entries    []fs.Entry
	ViewRoutes []router.ResolvedView
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
	}
	if err := root.ValidateRelativePath(dir); err != nil {
		return ListTreeOutput{}, err
	}
	entries, err := root.ListEntries(dir)
	if err != nil {
		return ListTreeOutput{}, err
	}
	routes := s.listViewRoutes(in.RootID, dir)
	return ListTreeOutput{Entries: entries, ViewRoutes: routes}, nil
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
	file, info, relPath, err := root.OpenFile(in.Path)
	if err != nil {
		return OpenFileRawOutput{}, err
	}
	return OpenFileRawOutput{File: file, Info: info, RelPath: relPath}, nil
}

type ReadFileInput struct {
	RootID   string
	Path     string
	MaxBytes int64
}

type ReadFileOutput struct {
	File       fs.ReadResult
	ViewRoutes []router.ResolvedView
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
	result, err := root.ReadFile(in.Path, in.MaxBytes)
	if err != nil {
		return ReadFileOutput{}, err
	}
	meta, err := root.GetFileMeta(in.Path)
	if err != nil {
		return ReadFileOutput{}, err
	}
	meta = fillFileMetaSessionInfo(ctx, s, in.RootID, meta)
	result.Root = root.ID
	result.FileMeta = meta
	routes := s.listViewRoutes(in.RootID, in.Path)
	return ReadFileOutput{File: result, ViewRoutes: routes}, nil
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
		sess, err := manager.Get(ctx, meta[i].SourceSession)
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
	meta, err := root.GetFileMeta(in.Path)
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
	Path string
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
	if !filepath.IsAbs(in.Path) {
		return AddManagedDirOutput{}, errors.New("path must be absolute")
	}
	abs := filepath.Clean(in.Path)
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return AddManagedDirOutput{}, errors.New("path must be a directory")
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

func (s *Service) listViewRoutes(rootID, path string) []router.ResolvedView {
	vm, err := s.Registry.GetViewManager(rootID)
	if err != nil || vm == nil {
		return nil
	}
	routes, err := vm.Routes(path)
	if err != nil {
		return nil
	}
	return routes
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
