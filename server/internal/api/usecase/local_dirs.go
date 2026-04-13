package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
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
	Path   string         `json:"path"`
	Parent string         `json:"parent,omitempty"`
	Items  []LocalDirItem `json:"items"`
}

func (s *Service) ListLocalDirs(_ context.Context, in ListLocalDirsInput) (ListLocalDirsOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ListLocalDirsOutput{}, err
	}
	cleaned := strings.TrimSpace(in.Path)
	if cleaned == "" {
		return ListLocalDirsOutput{}, errors.New("path required")
	}
	absPath, err := filepath.Abs(filepath.Clean(cleaned))
	if err != nil {
		return ListLocalDirsOutput{}, err
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return ListLocalDirsOutput{}, err
	}
	if !info.IsDir() {
		return ListLocalDirsOutput{}, errors.New("path is not a directory")
	}
	rootPathMap := make(map[string]string)
	for _, root := range s.Registry.ListRoots() {
		normalized := normalizeLocalDirPath(root.RootPath)
		if normalized == "" {
			continue
		}
		rootPathMap[normalized] = root.ID
	}
	entries, err := os.ReadDir(absPath)
	if err != nil {
		return ListLocalDirsOutput{}, err
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
		Path:   absPath,
		Parent: parent,
		Items:  items,
	}, nil
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
