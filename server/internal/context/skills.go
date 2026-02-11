package context

import (
	"encoding/json"
	"os"
	"path/filepath"

	"mindfs/server/internal/fs"
)

type skillConfig struct {
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Params      []ParamDef `json:"params"`
}

func LoadDirectorySkills(root fs.RootInfo) ([]SkillBrief, error) {
	entries, err := root.ListMetaEntries("skills")
	if err != nil {
		if os.IsNotExist(err) {
			return []SkillBrief{}, nil
		}
		return nil, err
	}
	items := []SkillBrief{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		configPath := filepath.Join("skills", entry.Name(), "config.json")
		payload, err := root.ReadMetaFile(configPath)
		if err != nil {
			continue
		}
		var cfg skillConfig
		if err := json.Unmarshal(payload, &cfg); err != nil {
			continue
		}
		items = append(items, SkillBrief{
			ID:          entry.Name(),
			Name:        cfg.Name,
			Description: cfg.Description,
			Params:      cfg.Params,
		})
	}
	return items, nil
}
