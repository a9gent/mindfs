package usecase

import (
	"context"

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
