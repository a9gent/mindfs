package skills

import (
	"encoding/json"
	"os"

	"mindfs/server/internal/fs"
)

const defaultConfigName = "config.json"

// DirConfig stores per-directory preferences.
type DirConfig struct {
	DefaultAgent    string `json:"defaultAgent"`
	UserDescription string `json:"userDescription"`
}

// LoadDirConfig reads .mindfs/config.json if present.
func LoadDirConfig(root fs.RootInfo) (DirConfig, error) {
	if root.MetaDir() == "" {
		return DirConfig{}, nil
	}
	payload, err := root.ReadMetaFile(defaultConfigName)
	if err != nil {
		if os.IsNotExist(err) {
			return DirConfig{}, nil
		}
		return DirConfig{}, err
	}
	var cfg DirConfig
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return DirConfig{}, err
	}
	return cfg, nil
}

// SaveDirConfig writes .mindfs/config.json with provided settings.
func SaveDirConfig(root fs.RootInfo, cfg DirConfig) error {
	if root.MetaDir() == "" {
		return nil
	}
	payload, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return root.WriteMetaFile(defaultConfigName, payload)
}
