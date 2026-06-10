package relay

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	configpkg "mindfs/server/internal/config"
)

type Credentials struct {
	Relay RelayCredentials `json:"relay"`
}

type RelayCredentials struct {
	DeviceToken string `json:"device_token"`
	NodeID      string `json:"node_id"`
	Endpoint    string `json:"endpoint"`
}

type CredentialsStore struct {
	mu       sync.RWMutex
	filePath string
}

func NewCredentialsStore() (*CredentialsStore, error) {
	configDir, err := configpkg.MindFSConfigDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return nil, err
	}
	return &CredentialsStore{filePath: filepath.Join(configDir, "credentials.json")}, nil
}

func (s *CredentialsStore) Load() (Credentials, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var creds Credentials
	payload, err := os.ReadFile(s.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return creds, nil
		}
		return creds, err
	}
	if err := json.Unmarshal(payload, &creds); err != nil {
		return Credentials{}, err
	}
	return creds, nil
}

func (s *CredentialsStore) Save(creds Credentials) error {
	if strings.TrimSpace(creds.Relay.DeviceToken) == "" || strings.TrimSpace(creds.Relay.Endpoint) == "" {
		return errors.New("relay credentials require device_token and endpoint")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	payload, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(s.filePath, payload, 0o600); err != nil {
		return err
	}
	return os.Chmod(s.filePath, 0o600)
}

func (s *CredentialsStore) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.Remove(s.filePath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
