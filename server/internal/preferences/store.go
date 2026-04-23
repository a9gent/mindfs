package preferences

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/config"
)

const preferencesFileName = "preferences.json"

type Store struct {
	mu   sync.RWMutex
	path string
	data UserPreferences
}

type UserPreferences struct {
	Agents map[string]AgentDefaults `json:"agents,omitempty"`
}

type AgentDefaults struct {
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
}

func NewStore() (*Store, error) {
	configDir, err := config.MindFSConfigDir()
	if err != nil {
		return nil, err
	}
	store := &Store{
		path: filepath.Join(configDir, preferencesFileName),
		data: UserPreferences{Agents: map[string]AgentDefaults{}},
	}
	if err := store.load(); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *Store) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	b, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return nil
	}
	var data UserPreferences
	if err := json.Unmarshal(b, &data); err != nil {
		return err
	}
	if data.Agents == nil {
		data.Agents = map[string]AgentDefaults{}
	}
	s.data = data
	return nil
}

func (s *Store) UpdateAgentDefaultsIfChanged(agentName, model, effort string) (bool, error) {
	if s == nil {
		return false, nil
	}
	agentName = strings.TrimSpace(agentName)
	if agentName == "" {
		return false, nil
	}
	model = strings.TrimSpace(model)
	effort = strings.TrimSpace(effort)
	if model == "" && effort == "" {
		return false, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.data.Agents == nil {
		s.data.Agents = map[string]AgentDefaults{}
	}
	next := s.data.Agents[agentName]
	if model != "" {
		next.Model = model
	}
	if effort != "" {
		next.Effort = effort
	}
	if s.data.Agents[agentName] == next {
		return false, nil
	}
	s.data.Agents[agentName] = next
	if err := s.saveLocked(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) ApplyAgentDefaults(statuses []agent.Status) []agent.Status {
	if s == nil || len(statuses) == 0 {
		return statuses
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.data.Agents) == 0 {
		return statuses
	}
	out := append([]agent.Status(nil), statuses...)
	for i := range out {
		defaults := s.data.Agents[strings.TrimSpace(out[i].Name)]
		if defaults.Model != "" {
			out[i].DefaultModelID = defaults.Model
		}
		if defaults.Effort != "" {
			out[i].DefaultEffort = defaults.Effort
		}
	}
	return out
}

func (s *Store) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(s.path)
		if retryErr := os.Rename(tmp, s.path); retryErr != nil {
			return err
		}
	}
	return nil
}
