package usecase

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	rootfs "mindfs/server/internal/fs"

	"gopkg.in/yaml.v3"
)

type CandidateType string

const (
	CandidateTypeFile  CandidateType = "file"
	CandidateTypeSkill CandidateType = "skill"
)

type CandidateItem struct {
	Type        CandidateType `json:"type"`
	Name        string        `json:"name"`
	Description string        `json:"description,omitempty"`
}

type SearchCandidatesInput struct {
	RootID string
	Type   CandidateType
	Query  string
	Agent  string
}

type SearchCandidatesOutput struct {
	Items []CandidateItem
}

type CandidateProvider interface {
	Type() CandidateType
	Search(ctx context.Context, root rootfs.RootInfo, agent, query string) ([]CandidateItem, error)
}

type CandidateRegistry struct {
	providers map[CandidateType]CandidateProvider
}

func NewCandidateRegistry() *CandidateRegistry {
	return &CandidateRegistry{providers: make(map[CandidateType]CandidateProvider)}
}

func (r *CandidateRegistry) Register(provider CandidateProvider) {
	if r == nil || provider == nil {
		return
	}
	r.providers[provider.Type()] = provider
}

func (r *CandidateRegistry) Search(ctx context.Context, candidateType CandidateType, root rootfs.RootInfo, agent, query string) ([]CandidateItem, error) {
	if r == nil {
		return nil, errors.New("candidate registry not configured")
	}
	provider := r.providers[candidateType]
	if provider == nil {
		return nil, errors.New("candidate provider not found")
	}
	return provider.Search(ctx, root, agent, query)
}

func (s *Service) SearchCandidates(ctx context.Context, in SearchCandidatesInput) (SearchCandidatesOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return SearchCandidatesOutput{}, err
	}
	if in.Type != CandidateTypeFile && in.Type != CandidateTypeSkill {
		return SearchCandidatesOutput{}, errors.New("invalid candidate type")
	}
	if in.Type == CandidateTypeSkill && strings.TrimSpace(in.Agent) == "" {
		return SearchCandidatesOutput{}, errors.New("agent required for skill candidates")
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return SearchCandidatesOutput{}, err
	}
	registry := s.Registry.GetCandidateRegistry()
	items, err := registry.Search(ctx, in.Type, root, in.Agent, in.Query)
	if err != nil {
		return SearchCandidatesOutput{}, err
	}
	return SearchCandidatesOutput{Items: items}, nil
}

type FileCandidateProvider struct{}

func NewFileCandidateProvider() *FileCandidateProvider {
	return &FileCandidateProvider{}
}

func (p *FileCandidateProvider) Type() CandidateType {
	return CandidateTypeFile
}

func (p *FileCandidateProvider) Search(ctx context.Context, root rootfs.RootInfo, _ string, query string) ([]CandidateItem, error) {
	rootDir, err := root.RootDir()
	if err != nil {
		return nil, err
	}
	query = strings.TrimSpace(strings.ToLower(query))
	items := make([]CandidateItem, 0, 32)
	err = filepath.WalkDir(rootDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if path == rootDir {
			return nil
		}
		relPath, err := root.NormalizePath(path)
		if err != nil {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if shouldIgnoreCandidatePath(relPath, entry.IsDir()) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if !matchesCandidateName(relPath, query) {
			return nil
		}
		items = append(items, CandidateItem{
			Type: CandidateTypeFile,
			Name: relPath,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sortCandidateItems(items, query)
	if len(items) > 20 {
		items = items[:20]
	}
	return items, nil
}

type SkillCandidateProvider struct{}

func NewSkillCandidateProvider() *SkillCandidateProvider {
	return &SkillCandidateProvider{}
}

func (p *SkillCandidateProvider) Type() CandidateType {
	return CandidateTypeSkill
}

func (p *SkillCandidateProvider) Search(ctx context.Context, root rootfs.RootInfo, agent, query string) ([]CandidateItem, error) {
	query = strings.TrimSpace(strings.ToLower(query))
	items := make([]CandidateItem, 0, 16)
	seen := make(map[string]struct{})
	for _, dir := range skillScanDirs(root, agent) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		for _, entry := range entries {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			default:
			}
			if !entry.IsDir() {
				continue
			}
			name := entry.Name()
			if name == "" {
				continue
			}
			if strings.HasPrefix(name, ".") {
				continue
			}
			if _, ok := seen[name]; ok {
				continue
			}
			if !matchesCandidateName(name, query) {
				continue
			}
			seen[name] = struct{}{}
			items = append(items, CandidateItem{
				Type:        CandidateTypeSkill,
				Name:        name,
				Description: readSkillDescription(filepath.Join(dir, name, "SKILL.md")),
			})
		}
	}
	sortCandidateItems(items, query)
	if len(items) > 20 {
		items = items[:20]
	}
	return items, nil
}

func shouldIgnoreCandidatePath(relPath string, isDir bool) bool {
	base := filepath.Base(relPath)
	if base == ".DS_Store" || base == "Thumbs.db" {
		return true
	}
	parts := strings.Split(filepath.ToSlash(relPath), "/")
	for _, part := range parts {
		if part == "" {
			continue
		}
		if strings.HasPrefix(part, ".") {
			return true
		}
		switch part {
		case "node_modules", "dist", "build", "coverage", ".next", ".nuxt", ".turbo", ".cache":
			return true
		}
	}
	return false
}

func matchesCandidateName(name, query string) bool {
	if query == "" {
		return true
	}
	lower := strings.ToLower(name)
	return strings.HasPrefix(lower, query) || strings.Contains(lower, query)
}

func sortCandidateItems(items []CandidateItem, query string) {
	query = strings.ToLower(strings.TrimSpace(query))
	sort.Slice(items, func(i, j int) bool {
		left := strings.ToLower(items[i].Name)
		right := strings.ToLower(items[j].Name)
		leftPrefix := query != "" && strings.HasPrefix(left, query)
		rightPrefix := query != "" && strings.HasPrefix(right, query)
		if leftPrefix != rightPrefix {
			return leftPrefix
		}
		if len(items[i].Name) != len(items[j].Name) {
			return len(items[i].Name) < len(items[j].Name)
		}
		return items[i].Name < items[j].Name
	})
}

func skillScanDirs(root rootfs.RootInfo, agent string) []string {
	homeDir, _ := os.UserHomeDir()
	rootDir, _ := root.RootDir()
	switch strings.TrimSpace(strings.ToLower(agent)) {
	case "codex":
		return []string{
			filepath.Join(homeDir, ".codex", "skills"),
			filepath.Join(homeDir, ".codex", "skills", ".system"),
			filepath.Join(homeDir, ".agents", "skills"),
			filepath.Join(rootDir, ".codex", "skills"),
		}
	case "claude":
		dirs := []string{
			filepath.Join(homeDir, ".claude", "skills"),
			filepath.Join(rootDir, ".claude", "skills"),
		}
		marketplacesRoot := filepath.Join(homeDir, ".claude", "plugins", "marketplaces")
		entries, err := os.ReadDir(marketplacesRoot)
		if err == nil {
			for _, entry := range entries {
				if !entry.IsDir() {
					continue
				}
				name := entry.Name()
				if name == "" || strings.HasPrefix(name, ".") {
					continue
				}
				dirs = append(dirs, filepath.Join(marketplacesRoot, name, "skills"))
			}
		}
		return dirs
	case "gemini":
		return []string{
			filepath.Join(homeDir, ".gemini", "skills"),
			filepath.Join(homeDir, ".agents", "skills"),
			filepath.Join(rootDir, ".gemini", "skills"),
		}
	default:
		return nil
	}
}

func readSkillDescription(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	content := string(data)
	if !strings.HasPrefix(content, "---\n") {
		return ""
	}
	rest := strings.TrimPrefix(content, "---\n")
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return ""
	}
	var frontmatter struct {
		Description string `yaml:"description"`
	}
	if err := yaml.Unmarshal([]byte(rest[:end]), &frontmatter); err != nil {
		return ""
	}
	return strings.TrimSpace(frontmatter.Description)
}
