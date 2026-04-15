package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	configpkg "mindfs/server/internal/config"
)

const maxPromptItems = 50

type PromptStore struct {
	mu       sync.RWMutex
	filePath string
}

func NewPromptStore() (*PromptStore, error) {
	configDir, err := configpkg.MindFSConfigDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return nil, err
	}
	return &PromptStore{filePath: filepath.Join(configDir, "prompts.json")}, nil
}

func (s *PromptStore) Load() ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.loadLocked()
}

func (s *PromptStore) Search(ctx context.Context, query string, limit int) ([]string, error) {
	items, err := s.Load()
	if err != nil {
		return nil, err
	}
	query = strings.ToLower(strings.TrimSpace(query))
	matches := make([]string, 0, len(items))
	for i := len(items) - 1; i >= 0; i-- {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		item := strings.TrimSpace(items[i])
		if item == "" || !matchesCandidateName(item, query) {
			continue
		}
		matches = append(matches, item)
		if limit > 0 && len(matches) >= limit {
			break
		}
	}
	return matches, nil
}

func (s *PromptStore) Append(text string) ([]string, error) {
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return nil, errors.New("prompt text required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	next := make([]string, 0, len(items)+1)
	for _, item := range items {
		if strings.TrimSpace(item) == "" || item == normalized {
			continue
		}
		next = append(next, item)
	}
	next = append(next, normalized)
	if len(next) > maxPromptItems {
		next = next[len(next)-maxPromptItems:]
	}
	if err := s.saveLocked(next); err != nil {
		return nil, err
	}
	return append([]string(nil), next...), nil
}

func (s *PromptStore) loadLocked() ([]string, error) {
	if s == nil {
		return nil, errors.New("prompt store not configured")
	}
	payload, err := os.ReadFile(s.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	var items []string
	if err := json.Unmarshal(payload, &items); err != nil {
		return nil, err
	}
	next := make([]string, 0, len(items))
	for _, item := range items {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		next = append(next, trimmed)
	}
	if len(next) > maxPromptItems {
		next = next[len(next)-maxPromptItems:]
	}
	return next, nil
}

func (s *PromptStore) saveLocked(items []string) error {
	payload, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.filePath, payload, 0o644)
}

type SavePromptInput struct {
	Text string
}

type SavePromptOutput struct {
	Items []string `json:"items"`
}

func (s *Service) SavePrompt(_ context.Context, in SavePromptInput) (SavePromptOutput, error) {
	if strings.TrimSpace(in.Text) == "" {
		return SavePromptOutput{}, errors.New("prompt text required")
	}
	store, err := NewPromptStore()
	if err != nil {
		return SavePromptOutput{}, err
	}
	items, err := store.Append(in.Text)
	if err != nil {
		return SavePromptOutput{}, err
	}
	return SavePromptOutput{Items: items}, nil
}
