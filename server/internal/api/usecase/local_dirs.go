package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"mindfs/server/internal/apperr"
)

type ListLocalDirsInput struct {
	Path string
}

type LocalDirItem struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsDir       bool   `json:"is_dir"`
	IsAddedRoot bool   `json:"is_added_root"`
	RootID      string `json:"root_id,omitempty"`
}

type ListLocalDirsOutput struct {
	Path    string         `json:"path"`
	Parent  string         `json:"parent,omitempty"`
	Volumes []LocalDirItem `json:"volumes,omitempty"`
	Items   []LocalDirItem `json:"items"`
}

func (s *Service) ListLocalDirs(_ context.Context, in ListLocalDirsInput) (ListLocalDirsOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ListLocalDirsOutput{}, err
	}
	cleaned := strings.TrimSpace(in.Path)
	if cleaned == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			return ListLocalDirsOutput{}, err
		}
		cleaned = homeDir
	}
	absPath, err := filepath.Abs(filepath.Clean(cleaned))
	if err != nil {
		return ListLocalDirsOutput{}, err
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return ListLocalDirsOutput{}, apperr.Wrap("stat", absPath, err)
	}
	if !info.IsDir() {
		return ListLocalDirsOutput{}, errors.New("path is not a directory")
	}
	rootPathMap := s.localDirRootPathMap()
	entries, err := os.ReadDir(absPath)
	if err != nil {
		return ListLocalDirsOutput{}, apperr.Wrap("list", absPath, err)
	}
	items := make([]LocalDirItem, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := strings.TrimSpace(entry.Name())
		if name == "" {
			continue
		}
		childPath := filepath.Join(absPath, name)
		normalizedChild := normalizeLocalDirPath(childPath)
		item := LocalDirItem{
			Name:  name,
			Path:  childPath,
			IsDir: true,
		}
		if rootID, ok := rootPathMap[normalizedChild]; ok {
			item.IsAddedRoot = true
			item.RootID = rootID
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	parent := filepath.Dir(absPath)
	if parent == absPath {
		parent = ""
	}
	return ListLocalDirsOutput{
		Path:    absPath,
		Parent:  parent,
		Volumes: listLocalDirVolumes(rootPathMap),
		Items:   items,
	}, nil
}

func (s *Service) localDirRootPathMap() map[string]string {
	rootPathMap := make(map[string]string)
	for _, root := range s.Registry.ListRoots() {
		normalized := normalizeLocalDirPath(root.RootPath)
		if normalized == "" {
			continue
		}
		rootPathMap[normalized] = root.ID
	}
	return rootPathMap
}

func normalizeLocalDirPath(path string) string {
	cleaned := strings.TrimSpace(path)
	if cleaned == "" {
		return ""
	}
	absPath, err := filepath.Abs(filepath.Clean(cleaned))
	if err != nil {
		return filepath.Clean(cleaned)
	}
	if runtime.GOOS == "windows" {
		return strings.ToLower(absPath)
	}
	return absPath
}
