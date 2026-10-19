package preferences

import (
	"errors"
	"strings"
)

func (s *Store) PinnedModels(agent string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]string{}, s.data.AgentPinnedModels[strings.TrimSpace(agent)]...)
}

// SetModelPinned changes one model under the store lock so simultaneous pins
// from different clients cannot overwrite each other or other preferences.
func (s *Store) SetModelPinned(agent, model string, pinned bool) ([]string, error) {
	agent, model = strings.TrimSpace(agent), strings.TrimSpace(model)
	if agent == "" || model == "" {
		return nil, errors.New("agent and model are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, existed := s.data.AgentPinnedModels[agent]
	next := make([]string, 0, len(previous)+1)
	for _, id := range previous {
		if id != model {
			next = append(next, id)
		}
	}
	if pinned {
		next = append(next, model)
	}
	if s.data.AgentPinnedModels == nil {
		s.data.AgentPinnedModels = make(map[string][]string)
	}
	if len(next) == 0 {
		delete(s.data.AgentPinnedModels, agent)
	} else {
		s.data.AgentPinnedModels[agent] = next
	}
	if err := s.saveLocked(); err != nil {
		if existed {
			s.data.AgentPinnedModels[agent] = previous
		} else {
			delete(s.data.AgentPinnedModels, agent)
		}
		return nil, err
	}
	return append([]string{}, next...), nil
}
