package preferences

import (
	"encoding/json"
	"errors"
	"strings"
)

// Snapshot returns a detached copy, including maps and nested selections.
func (s *Store) Snapshot() UserPreferences {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, _ := json.Marshal(s.data)
	var out UserPreferences
	_ = json.Unmarshal(b, &out)
	return out
}

// ValidateTransfer validates the preference fields accepted by configuration import.
func ValidateTransfer(fields map[string]json.RawMessage) error {
	allowed := map[string]bool{
		"agent_pinned_models": true, "agents": true, "last_agent": true,
		"session_naming": true, "idle_session_resource_release_hours": true,
		"new_project_meta_location": true, "launcher_nodes": true,
	}
	for key, value := range fields {
		if !allowed[key] || strings.TrimSpace(string(value)) == "null" {
			return errors.New("invalid preference field: " + key)
		}
	}
	b, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	var p UserPreferences
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	if p.IdleSessionResourceReleaseHours < 0 || p.IdleSessionResourceReleaseHours > MaxIdleSessionResourceReleaseHours {
		return errors.New("idle session resource release hours are out of range")
	}
	if p.NewProjectMetaLocation != "" && p.NewProjectMetaLocation != "home" && p.NewProjectMetaLocation != "project" {
		return errors.New("invalid new project metadata location")
	}
	_, err = normalizeLauncherNodes(p.LauncherNodes)
	return err
}

// ImportFields changes only selected fields, preserving concurrent changes to others.
func (s *Store) ImportFields(fields map[string]json.RawMessage) error {
	if err := ValidateTransfer(fields); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	b, _ := json.Marshal(s.data)
	var merged map[string]json.RawMessage
	_ = json.Unmarshal(b, &merged)
	for key, value := range fields {
		merged[key] = value
	}
	b, err := json.Marshal(merged)
	if err != nil {
		return err
	}
	var next UserPreferences
	if err := json.Unmarshal(b, &next); err != nil {
		return err
	}
	if next.Agents == nil {
		next.Agents = map[string]AgentDefaults{}
	}
	if _, ok := fields["launcher_nodes"]; ok {
		next.LauncherNodes, err = normalizeLauncherNodes(next.LauncherNodes)
		if err != nil {
			return err
		}
	}
	previous := s.data
	s.data = next
	if err := s.saveLocked(); err != nil {
		s.data = previous
		return err
	}
	return nil
}
