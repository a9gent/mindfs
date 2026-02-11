package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"mindfs/server/internal/fs"
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

func (s *Service) ListTree(_ context.Context, in ListTreeInput) (ListTreeOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ListTreeOutput{}, err
	}
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
	File fs.ReadResult
}

func (s *Service) ReadFile(_ context.Context, in ReadFileInput) (ReadFileOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ReadFileOutput{}, err
	}
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
	result.Root = root.ID
	return ReadFileOutput{File: result}, nil
}

type GetFileMetaInput struct {
	RootID string
	Path   string
}

type GetFileMetaOutput struct {
	Meta *fs.FileMetaEntry
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
