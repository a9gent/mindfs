package usecase

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"mindfs/server/internal/skills"
)

type GetDirConfigInput struct {
	RootID string
}

type GetDirConfigOutput struct {
	Config skills.DirConfig
}

func (s *Service) GetDirConfig(_ context.Context, in GetDirConfigInput) (GetDirConfigOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return GetDirConfigOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return GetDirConfigOutput{}, err
	}
	cfg, err := skills.LoadDirConfig(root)
	if err != nil {
		return GetDirConfigOutput{}, err
	}
	return GetDirConfigOutput{Config: cfg}, nil
}

type SetDirConfigInput struct {
	RootID string
	Config skills.DirConfig
}

func (s *Service) SetDirConfig(_ context.Context, in SetDirConfigInput) error {
	if err := s.ensureRegistry(); err != nil {
		return err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return err
	}
	in.Config.UserDescription = strings.TrimSpace(in.Config.UserDescription)
	in.Config.DefaultAgent = strings.TrimSpace(in.Config.DefaultAgent)
	return skills.SaveDirConfig(root, in.Config)
}

type ExecuteSkillInput struct {
	RootID  string
	SkillID string
	Params  map[string]any
}

type ExecuteSkillOutput struct {
	Result any
}

func (s *Service) ExecuteSkill(ctx context.Context, in ExecuteSkillInput) (ExecuteSkillOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ExecuteSkillOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return ExecuteSkillOutput{}, err
	}
	skill, err := skills.LoadSkill(root, in.SkillID)
	if err != nil {
		return ExecuteSkillOutput{}, err
	}
	result, err := skills.ExecuteSkill(ctx, skill, in.Params)
	if err != nil {
		return ExecuteSkillOutput{}, err
	}
	return ExecuteSkillOutput{Result: result}, nil
}

type ListDirectorySkillsInput struct {
	RootID string
}

type ListDirectorySkillsOutput struct {
	Skills []map[string]any
}

func (s *Service) ListDirectorySkills(_ context.Context, in ListDirectorySkillsInput) (ListDirectorySkillsOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ListDirectorySkillsOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return ListDirectorySkillsOutput{}, err
	}
	out := make([]map[string]any, 0)
	entries, err := root.ListMetaEntries("skills")
	if err != nil {
		if os.IsNotExist(err) {
			return ListDirectorySkillsOutput{Skills: out}, nil
		}
		return ListDirectorySkillsOutput{}, err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		ext := filepath.Ext(name)
		if ext != ".json" && ext != ".yaml" && ext != ".yml" {
			continue
		}
		skillID := name[:len(name)-len(ext)]
		data, err := root.ReadMetaFile(filepath.Join("skills", name))
		if err != nil {
			continue
		}
		var meta map[string]any
		if err := json.Unmarshal(data, &meta); err != nil {
			continue
		}
		skillName, _ := meta["name"].(string)
		if skillName == "" {
			skillName = skillID
		}
		description, _ := meta["description"].(string)
		out = append(out, map[string]any{
			"id":          skillID,
			"name":        skillName,
			"description": description,
			"source":      "directory",
		})
	}
	return ListDirectorySkillsOutput{Skills: out}, nil
}
