package e2ee

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"

	configpkg "mindfs/server/internal/config"
)

const (
	pairingSecretBytes = 16
	nodeIDBytes        = 16
)

var base62Alphabet = []byte("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")

type Config struct {
	Enabled       bool   `json:"enabled"`
	NodeID        string `json:"node_id"`
	PairingSecret string `json:"pairing_secret"`
}

type EnsureResult struct {
	Config    Config
	Generated bool
}

func DefaultConfigPath() (string, error) {
	dir, err := configpkg.MindFSConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "e2ee.json"), nil
}

func EnsureConfig(enabled bool) (EnsureResult, error) {
	path, err := DefaultConfigPath()
	if err != nil {
		return EnsureResult{}, err
	}
	return EnsureConfigAtPath(path, enabled)
}

func EnsureConfigAtPath(path string, enabled bool) (EnsureResult, error) {
	trimmedPath := strings.TrimSpace(path)
	if trimmedPath == "" {
		return EnsureResult{}, errors.New("e2ee config path required")
	}
	if err := os.MkdirAll(filepath.Dir(trimmedPath), 0o755); err != nil {
		return EnsureResult{}, err
	}
	cfg, err := loadConfig(trimmedPath)
	if err != nil {
		return EnsureResult{}, err
	}
	generated := false
	if strings.TrimSpace(cfg.NodeID) == "" {
		cfg.NodeID, err = randomBase62(nodeIDBytes)
		if err != nil {
			return EnsureResult{}, err
		}
		generated = true
	}
	if enabled && strings.TrimSpace(cfg.PairingSecret) == "" {
		cfg.PairingSecret, err = randomBase62(pairingSecretBytes)
		if err != nil {
			return EnsureResult{}, err
		}
		generated = true
	}
	if cfg.Enabled != enabled {
		cfg.Enabled = enabled
		generated = true
	}
	if generated {
		if err := saveConfig(trimmedPath, cfg); err != nil {
			return EnsureResult{}, err
		}
	}
	return EnsureResult{Config: cfg, Generated: generated}, nil
}

func loadConfig(path string) (Config, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Config{}, nil
		}
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return Config{}, err
	}
	cfg.NodeID = strings.TrimSpace(cfg.NodeID)
	cfg.PairingSecret = strings.TrimSpace(cfg.PairingSecret)
	return cfg, nil
}

func saveConfig(path string, cfg Config) error {
	payload, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	return os.WriteFile(path, payload, 0o600)
}

func randomBase62(n int) (string, error) {
	if n <= 0 {
		return "", errors.New("positive byte length required")
	}
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return encodeBase62(raw), nil
}

func encodeBase62(raw []byte) string {
	if len(raw) == 0 {
		return "0"
	}
	num := new(big.Int).SetBytes(raw)
	if num.Sign() == 0 {
		return "0"
	}
	base := big.NewInt(62)
	zero := big.NewInt(0)
	remainder := new(big.Int)
	out := make([]byte, 0, len(raw)*2)
	for num.Cmp(zero) > 0 {
		num.DivMod(num, base, remainder)
		out = append(out, base62Alphabet[remainder.Int64()])
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}
