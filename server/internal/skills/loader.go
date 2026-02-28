package skills

import (
	"encoding/json"
	"errors"
	"path/filepath"

	"mindfs/server/internal/fs"
)

// SkillManifest describes a skill's metadata.
type SkillManifest struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Permissions []string `json:"permissions,omitempty"`
}

type SkillRuntimeConfig struct {
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Params      []ParamDef `json:"params,omitempty"`
	Command     string     `json:"command,omitempty"`
	Args        []string   `json:"args,omitempty"`
	Permissions []string   `json:"permissions,omitempty"`
}

type ParamDef struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
}

type LoadedSkill struct {
	ID       string
	Manifest SkillManifest
	Config   SkillRuntimeConfig
}

func LoadSkill(root fs.RootInfo, skillID string) (LoadedSkill, error) {
	if root.MetaDir() == "" {
		return LoadedSkill{}, errors.New("managed dir required")
	}
	if skillID == "" {
		return LoadedSkill{}, errors.New("skill id required")
	}
	manifestPath := filepath.Join("skills", skillID, "manifest.json")
	configPath := filepath.Join("skills", skillID, "config.json")

	var manifest SkillManifest
	if payload, err := root.ReadMetaFile(manifestPath); err == nil {
		json.Unmarshal(payload, &manifest)
	}
	var cfg SkillRuntimeConfig
	payload, err := root.ReadMetaFile(configPath)
	if err != nil {
		return LoadedSkill{}, err
	}
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return LoadedSkill{}, err
	}
	if cfg.Name == "" {
		cfg.Name = skillID
	}
	if len(cfg.Permissions) == 0 && len(manifest.Permissions) > 0 {
		cfg.Permissions = append(cfg.Permissions, manifest.Permissions...)
	}
	return LoadedSkill{ID: skillID, Manifest: manifest, Config: cfg}, nil
}
