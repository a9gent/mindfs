package context

import (
	"context"
	"path/filepath"
	"sort"

	"mindfs/server/internal/session"
)

func FindRelatedSessions(manager *session.Manager, currentPath string, limit int) ([]SessionBrief, error) {
	if manager == nil {
		return []SessionBrief{}, nil
	}
	sessions, err := manager.List(context.Background())
	if err != nil {
		return nil, err
	}
	fileRelated := []SessionBrief{}
	dirRelated := []SessionBrief{}
	rootRelated := []SessionBrief{}
	for _, s := range sessions {
		brief := toBrief(s)
		if currentPath != "" && hasRelatedFile(s, currentPath) {
			fileRelated = append(fileRelated, brief)
			continue
		}
		if currentPath != "" && hasRelatedDir(s, filepath.Dir(currentPath)) {
			dirRelated = append(dirRelated, brief)
			continue
		}
		rootRelated = append(rootRelated, brief)
	}
	sortByTime := func(list []SessionBrief) {
		sort.Slice(list, func(i, j int) bool {
			return list[i].UpdatedAt.After(list[j].UpdatedAt)
		})
	}
	sortByTime(fileRelated)
	sortByTime(dirRelated)
	sortByTime(rootRelated)
	combined := append(fileRelated, append(dirRelated, rootRelated...)...)
	if limit <= 0 {
		limit = 3
	}
	if len(combined) > limit {
		combined = combined[:limit]
	}
	return combined, nil
}

func toBrief(s *session.Session) SessionBrief {
	files := []string{}
	for _, rel := range s.RelatedFiles {
		files = append(files, rel.Path)
	}
	return SessionBrief{
		Key:          s.Key,
		Type:         s.Type,
		Name:         s.Name,
		Status:       s.Status,
		UpdatedAt:    s.UpdatedAt,
		RelatedFiles: files,
	}
}

func hasRelatedFile(s *session.Session, path string) bool {
	for _, rel := range s.RelatedFiles {
		if rel.Path == path {
			return true
		}
	}
	return false
}

func hasRelatedDir(s *session.Session, dir string) bool {
	for _, rel := range s.RelatedFiles {
		if filepath.Dir(rel.Path) == dir {
			return true
		}
	}
	return false
}
