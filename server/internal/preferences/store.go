package preferences

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/config"
)

const preferencesFileName = "preferences.json"

const DefaultIdleSessionResourceReleaseHours = 72
const MaxIdleSessionResourceReleaseHours = 2_562_047

type Store struct {
	mu   sync.RWMutex
	path string
	data UserPreferences
}

type UserPreferences struct {
	AgentPinnedModels               map[string][]string      `json:"agent_pinned_models,omitempty"`
	LauncherNodes                   []LauncherNode           `json:"launcher_nodes,omitempty"`
	Agents                          map[string]AgentDefaults `json:"agents,omitempty"`
	LastAgent                       string                   `json:"last_agent,omitempty"`
	SessionNaming                   SessionNamingDefaults    `json:"session_naming,omitempty"`
	IdleSessionResourceReleaseHours int                      `json:"idle_session_resource_release_hours,omitempty"`
	NewProjectMetaLocation          string                   `json:"new_project_meta_location,omitempty"`
	AgentHidden                     []string                 `json:"agent_hidden,omitempty"`
	AgentVisibilityCustomized       bool                     `json:"agent_visibility_customized,omitempty"`
	UILayout                        *storedUILayout          `json:"ui_layout,omitempty"`
	// ForkOwnership decides where a newly forked session lands:
	//   "nested"   – under its parent session (default, cascade-deleted with it)
	//   "detached" – at top level, parallel to the parent, survives its deletion
	ForkOwnership string `json:"fork_ownership,omitempty"`
}

// UILayout is the browser panel arrangement, kept server-side so it follows the
// user across entrances (LAN address, tailnet hostname, port, PWA) instead of
// living only in one origin's localStorage.
type UILayout struct {
	Configured        bool
	SidebarsSwapped   bool
	GitDiffSideBySide bool
}

// storedUILayout keeps pointers so an unset preference stays distinguishable
// from an explicit false.
type storedUILayout struct {
	SidebarsSwapped   *bool `json:"sidebars_swapped,omitempty"`
	GitDiffSideBySide *bool `json:"git_diff_side_by_side,omitempty"`
}

type LauncherNode struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	CreatedAt string `json:"createdAt"`
}

func (s *Store) LauncherNodes() []LauncherNode {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]LauncherNode{}, s.data.LauncherNodes...)
}

func (s *Store) UpdateLauncherNodes(nodes []LauncherNode) error {
	if len(nodes) > 1000 {
		return errors.New("too many nodes")
	}
	next := append([]LauncherNode{}, nodes...)
	ids, urls := map[string]bool{}, map[string]bool{}
	for i := range next {
		n := &next[i]
		n.ID, n.Name, n.URL = strings.TrimSpace(n.ID), strings.TrimSpace(n.Name), strings.TrimSpace(n.URL)
		u, err := url.Parse(n.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || n.ID == "" || n.Name == "" || n.CreatedAt == "" {
			return errors.New("invalid node: name, id, creation time and HTTP(S) URL are required")
		}
		if ids[n.ID] || urls[n.URL] {
			return errors.New("duplicate node")
		}
		ids[n.ID], urls[n.URL] = true, true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := s.data.LauncherNodes
	s.data.LauncherNodes = next
	if err := s.saveLocked(); err != nil {
		s.data.LauncherNodes = previous
		return err
	}
	return nil
}

func (s *Store) NewProjectMetaLocation() string {
	if s == nil {
		return "project"
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.data.NewProjectMetaLocation == "home" {
		return "home"
	}
	return "project"
}

func (s *Store) UpdateNewProjectMetaLocation(location string) error {
	if s == nil {
		return nil
	}
	location = strings.TrimSpace(location)
	if location != "project" && location != "home" {
		return errors.New("invalid new project metadata location")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.NewProjectMetaLocation == location {
		return nil
	}
	s.data.NewProjectMetaLocation = location
	return s.saveLocked()
}

func (s *Store) UILayout() UILayout {
	if s == nil {
		return UILayout{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	stored := s.data.UILayout
	if stored == nil {
		return UILayout{}
	}
	out := UILayout{
		Configured:        stored.SidebarsSwapped != nil || stored.GitDiffSideBySide != nil,
		SidebarsSwapped:   stored.SidebarsSwapped != nil && *stored.SidebarsSwapped,
		GitDiffSideBySide: stored.GitDiffSideBySide != nil && *stored.GitDiffSideBySide,
	}
	return out
}

func (s *Store) UpdateUILayout(sidebarsSwapped, gitDiffSideBySide bool) error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if current := s.data.UILayout; current != nil && current.SidebarsSwapped != nil && current.GitDiffSideBySide != nil &&
		*current.SidebarsSwapped == sidebarsSwapped && *current.GitDiffSideBySide == gitDiffSideBySide {
		return nil
	}
	next := &storedUILayout{SidebarsSwapped: &sidebarsSwapped, GitDiffSideBySide: &gitDiffSideBySide}
	previous := s.data.UILayout
	s.data.UILayout = next
	if err := s.saveLocked(); err != nil {
		s.data.UILayout = previous
		return err
	}
	return nil
}

const (
	ForkOwnershipNested   = "nested"
	ForkOwnershipDetached = "detached"
)

// ForkOwnership returns the default placement for newly forked sessions.
func (s *Store) ForkOwnership() string {
	if s == nil {
		return ForkOwnershipNested
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.data.ForkOwnership == ForkOwnershipDetached {
		return ForkOwnershipDetached
	}
	return ForkOwnershipNested
}

func (s *Store) UpdateForkOwnership(ownership string) error {
	if s == nil {
		return nil
	}
	ownership = strings.TrimSpace(ownership)
	if ownership != ForkOwnershipNested && ownership != ForkOwnershipDetached {
		return errors.New("invalid fork ownership")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.ForkOwnership == ownership {
		return nil
	}
	previous := s.data.ForkOwnership
	s.data.ForkOwnership = ownership
	if err := s.saveLocked(); err != nil {
		// Keep memory and disk consistent: a failed write must not leave the
		// process on the new value while the file still holds the old one.
		s.data.ForkOwnership = previous
		return err
	}
	return nil
}

func (s *Store) IdleSessionResourceReleaseHours() int {
	if s == nil {
		return DefaultIdleSessionResourceReleaseHours
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.data.IdleSessionResourceReleaseHours <= 0 {
		return DefaultIdleSessionResourceReleaseHours
	}
	return s.data.IdleSessionResourceReleaseHours
}

func (s *Store) UpdateIdleSessionResourceReleaseHours(hours int) error {
	if s == nil {
		return nil
	}
	if hours <= 0 || hours > MaxIdleSessionResourceReleaseHours {
		return errors.New("idle session resource release hours are out of range")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.IdleSessionResourceReleaseHours == hours {
		return nil
	}
	s.data.IdleSessionResourceReleaseHours = hours
	return s.saveLocked()
}

type SessionNamingDefaults struct {
	Agent    string `json:"agent,omitempty"`
	Model    string `json:"model,omitempty"`
	Disabled bool   `json:"disabled,omitempty"`
}

type AgentDefaults struct {
	Model               string               `json:"model,omitempty"`
	Effort              string               `json:"effort,omitempty"`
	FastService         string               `json:"fast_service,omitempty"`
	LastConfigSelection *LastConfigSelection `json:"last_config_selection,omitempty"`
}

type LastConfigSelection struct {
	Type string `json:"type,omitempty"`
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
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

func (s *Store) UpdateAgentDefaultsIfChanged(agentName, model, effort, fastService string) (bool, error) {
	if s == nil {
		return false, nil
	}
	agentName = strings.TrimSpace(agentName)
	if agentName == "" {
		return false, nil
	}
	model = strings.TrimSpace(model)
	effort = strings.TrimSpace(effort)
	fastService = strings.TrimSpace(fastService)
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
	if fastService != "" {
		next.FastService = fastService
	}
	if s.data.Agents[agentName] == next && s.data.LastAgent == agentName {
		return false, nil
	}
	previousDefaults, existed := s.data.Agents[agentName]
	previousAgent := s.data.LastAgent
	s.data.Agents[agentName] = next
	s.data.LastAgent = agentName
	if err := s.saveLocked(); err != nil {
		if existed {
			s.data.Agents[agentName] = previousDefaults
		} else {
			delete(s.data.Agents, agentName)
		}
		s.data.LastAgent = previousAgent
		return false, err
	}
	return true, nil
}

func (s *Store) UpdateAgentLastConfigSelection(agentName string, selection LastConfigSelection) error {
	if s == nil {
		return nil
	}
	agentName = strings.TrimSpace(agentName)
	selection.Type = strings.TrimSpace(selection.Type)
	selection.ID = strings.TrimSpace(selection.ID)
	selection.Name = strings.TrimSpace(selection.Name)
	if agentName == "" || selection.Type == "" || selection.ID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.data.Agents == nil {
		s.data.Agents = map[string]AgentDefaults{}
	}
	next := s.data.Agents[agentName]
	if next.LastConfigSelection != nil && *next.LastConfigSelection == selection {
		return nil
	}
	next.LastConfigSelection = &selection
	s.data.Agents[agentName] = next
	return s.saveLocked()
}

// AgentLastConfigSelections returns a snapshot of every agent's last manual
// config selection keyed by agent name. Callers must treat the result as
// read-only.
func (s *Store) AgentLastConfigSelections() map[string]LastConfigSelection {
	out := map[string]LastConfigSelection{}
	if s == nil {
		return out
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for name, defaults := range s.data.Agents {
		if defaults.LastConfigSelection != nil {
			out[strings.TrimSpace(name)] = *defaults.LastConfigSelection
		}
	}
	return out
}

// AgentVisibility returns the hidden-agent list and whether the user has ever
// customized visibility. customized=false means "never touched": the web layer
// applies its default folding rule instead of the (empty) list.
func (s *Store) AgentVisibility() ([]string, bool) {
	if s == nil {
		return nil, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]string{}, s.data.AgentHidden...), s.data.AgentVisibilityCustomized
}

func (s *Store) UpdateAgentVisibility(hidden []string, customized bool) error {
	if s == nil {
		return nil
	}
	if len(hidden) > 1000 {
		return errors.New("too many hidden agents")
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(hidden))
	for _, name := range hidden {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.AgentHidden = out
	s.data.AgentVisibilityCustomized = customized
	return s.saveLocked()
}

func (s *Store) SessionNamingDefaults() SessionNamingDefaults {
	if s == nil {
		return SessionNamingDefaults{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.data.SessionNaming
}

func (s *Store) UpdateSessionNamingDefaults(agentName, model string, disabled bool) error {
	if s == nil {
		return nil
	}
	next := SessionNamingDefaults{
		Agent:    strings.TrimSpace(agentName),
		Model:    strings.TrimSpace(model),
		Disabled: disabled,
	}
	if next.Agent == "" && !next.Disabled {
		return errors.New("session naming agent is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.SessionNaming == next {
		return nil
	}
	s.data.SessionNaming = next
	return s.saveLocked()
}

func (s *Store) ApplyAgentDefaults(statuses []agent.Status) []agent.Status {
	if s == nil || len(statuses) == 0 {
		return statuses
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.data.Agents) == 0 && s.data.LastAgent == "" && len(s.data.AgentPinnedModels) == 0 {
		return statuses
	}
	out := append([]agent.Status(nil), statuses...)
	for i := range out {
		out[i].PinnedModels = append([]string{}, s.data.AgentPinnedModels[strings.TrimSpace(out[i].Name)]...)
		out[i].LastUsed = s.data.LastAgent == strings.TrimSpace(out[i].Name)
		defaults := s.data.Agents[strings.TrimSpace(out[i].Name)]
		if defaults.Model != "" {
			out[i].DefaultModelID = defaults.Model
		}
		if defaults.Effort != "" {
			out[i].DefaultEffort = defaults.Effort
		}
		if defaults.FastService != "" {
			out[i].DefaultFastService = defaults.FastService
		}
		if defaults.LastConfigSelection != nil {
			out[i].LastConfigSelection = *defaults.LastConfigSelection
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
