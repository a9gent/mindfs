package preferences

import (
	"os"
	"path/filepath"
	"testing"

	"mindfs/server/internal/agent"
)

func TestLastAgentPersistsWithAgentDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), preferencesFileName)
	store := &Store{path: path}
	for _, name := range []string{"claude", "codex", " claude "} {
		// Switching back must persist even when this agent's model is unchanged.
		changed, err := store.UpdateAgentDefaultsIfChanged(name, " model ", " high ", " on ")
		if err != nil || !changed {
			t.Fatalf("update %q: changed=%v, err=%v", name, changed, err)
		}
	}
	if changed, err := store.UpdateAgentDefaultsIfChanged("claude", "model", "high", "on"); err != nil || changed {
		t.Fatalf("unchanged update: changed=%v, err=%v", changed, err)
	}
	if changed, err := store.UpdateAgentDefaultsIfChanged(" ", "", "", ""); err != nil || changed {
		t.Fatalf("empty agent update: changed=%v, err=%v", changed, err)
	}
	reloaded := &Store{path: path}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	statuses := []agent.Status{{Name: "codex", Available: true}, {Name: "claude", Available: true}}
	got := reloaded.ApplyAgentDefaults(statuses)
	if got[0].LastUsed || !got[1].LastUsed {
		t.Fatalf("last agent not restored: %#v", got)
	}
	if got[1].DefaultModelID != "model" || got[1].DefaultEffort != "high" || got[1].DefaultFastService != "on" {
		t.Fatalf("agent defaults not restored: %#v", got[1])
	}
	if statuses[1].LastUsed {
		t.Fatal("ApplyAgentDefaults mutated the probe statuses")
	}
}

func TestLastAgentLegacyPreferences(t *testing.T) {
	path := filepath.Join(t.TempDir(), preferencesFileName)
	if err := os.WriteFile(path, []byte(`{"agents":{"claude":{"model":"sonnet"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store := &Store{path: path}
	if err := store.load(); err != nil {
		t.Fatal(err)
	}
	got := store.ApplyAgentDefaults([]agent.Status{{Name: "claude"}})
	if got[0].LastUsed || got[0].DefaultModelID != "sonnet" {
		t.Fatalf("legacy preferences changed: %#v", got)
	}
	if changed, err := store.UpdateAgentDefaultsIfChanged("claude", "sonnet", "", ""); err != nil || !changed {
		t.Fatalf("first use after upgrade: changed=%v, err=%v", changed, err)
	}
}

func TestLastAgentSaveFailureCanBeRetried(t *testing.T) {
	dir := t.TempDir()
	blockedDir := filepath.Join(dir, "blocked")
	if err := os.WriteFile(blockedDir, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	store := &Store{path: filepath.Join(blockedDir, preferencesFileName)}
	if changed, err := store.UpdateAgentDefaultsIfChanged("claude", "sonnet", "", ""); err == nil || changed {
		t.Fatalf("failed save: changed=%v, err=%v", changed, err)
	}
	store.path = filepath.Join(dir, preferencesFileName)
	if changed, err := store.UpdateAgentDefaultsIfChanged("claude", "sonnet", "", ""); err != nil || !changed {
		t.Fatalf("retry: changed=%v, err=%v", changed, err)
	}
}

func TestSessionNamingDefaultsPersistAndReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), preferencesFileName)
	store := &Store{
		path: path,
		data: UserPreferences{Agents: map[string]AgentDefaults{}},
	}
	if err := store.UpdateSessionNamingDefaults(" codex ", " gpt-5.4 ", true); err != nil {
		t.Fatalf("UpdateSessionNamingDefaults: %v", err)
	}
	if got := store.SessionNamingDefaults(); got != (SessionNamingDefaults{Agent: "codex", Model: "gpt-5.4", Disabled: true}) {
		t.Fatalf("SessionNamingDefaults = %#v", got)
	}

	reloaded := &Store{
		path: path,
		data: UserPreferences{Agents: map[string]AgentDefaults{}},
	}
	if err := reloaded.load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := reloaded.SessionNamingDefaults(); got != (SessionNamingDefaults{Agent: "codex", Model: "gpt-5.4", Disabled: true}) {
		t.Fatalf("reloaded SessionNamingDefaults = %#v", got)
	}
}

func TestSessionNamingDefaultsAllowDefaultModel(t *testing.T) {
	store := &Store{
		path: filepath.Join(t.TempDir(), preferencesFileName),
		data: UserPreferences{Agents: map[string]AgentDefaults{}},
	}
	if err := store.UpdateSessionNamingDefaults("codex", "", false); err != nil {
		t.Fatalf("UpdateSessionNamingDefaults with default model: %v", err)
	}
	if got := store.SessionNamingDefaults(); got != (SessionNamingDefaults{Agent: "codex"}) {
		t.Fatalf("SessionNamingDefaults = %#v", got)
	}
	if err := store.UpdateSessionNamingDefaults("", "gpt-5.4", false); err == nil {
		t.Fatal("UpdateSessionNamingDefaults without agent succeeded")
	}
	if err := store.UpdateSessionNamingDefaults("", "", true); err != nil {
		t.Fatalf("UpdateSessionNamingDefaults disabled without agent: %v", err)
	}
	if got := store.SessionNamingDefaults(); got != (SessionNamingDefaults{Disabled: true}) {
		t.Fatalf("disabled SessionNamingDefaults = %#v", got)
	}
}

func TestIdleSessionResourceReleaseHoursDefaultAndPersist(t *testing.T) {
	path := filepath.Join(t.TempDir(), preferencesFileName)
	store := &Store{path: path, data: UserPreferences{Agents: map[string]AgentDefaults{}}}
	if got := store.IdleSessionResourceReleaseHours(); got != 72 {
		t.Fatalf("default hours = %d, want 72", got)
	}
	if err := store.UpdateIdleSessionResourceReleaseHours(24); err != nil {
		t.Fatalf("UpdateIdleSessionResourceReleaseHours: %v", err)
	}
	reloaded := &Store{path: path, data: UserPreferences{Agents: map[string]AgentDefaults{}}}
	if err := reloaded.load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := reloaded.IdleSessionResourceReleaseHours(); got != 24 {
		t.Fatalf("reloaded hours = %d, want 24", got)
	}
	if err := store.UpdateIdleSessionResourceReleaseHours(0); err == nil {
		t.Fatal("zero hours unexpectedly accepted")
	}
}

func TestNewProjectMetaLocationDefaultAndPersist(t *testing.T) {
	path := filepath.Join(t.TempDir(), preferencesFileName)
	store := &Store{path: path, data: UserPreferences{Agents: map[string]AgentDefaults{}}}
	if got := store.NewProjectMetaLocation(); got != "project" {
		t.Fatalf("default location = %q", got)
	}
	if err := store.UpdateNewProjectMetaLocation("home"); err != nil {
		t.Fatal(err)
	}
	reloaded := &Store{path: path, data: UserPreferences{Agents: map[string]AgentDefaults{}}}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	if got := reloaded.NewProjectMetaLocation(); got != "home" {
		t.Fatalf("reloaded location = %q", got)
	}
	if err := store.UpdateNewProjectMetaLocation("other"); err == nil {
		t.Fatal("invalid location unexpectedly accepted")
	}
}

func TestForkOwnershipDefaultAndPersist(t *testing.T) {
	path := filepath.Join(t.TempDir(), preferencesFileName)
	store := &Store{path: path, data: UserPreferences{Agents: map[string]AgentDefaults{}}}
	if got := store.ForkOwnership(); got != ForkOwnershipNested {
		t.Fatalf("default ownership = %q", got)
	}
	if err := store.UpdateForkOwnership(ForkOwnershipDetached); err != nil {
		t.Fatal(err)
	}
	reloaded := &Store{path: path, data: UserPreferences{Agents: map[string]AgentDefaults{}}}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	if got := reloaded.ForkOwnership(); got != ForkOwnershipDetached {
		t.Fatalf("reloaded ownership = %q", got)
	}
	if err := store.UpdateForkOwnership("sideways"); err == nil {
		t.Fatal("invalid ownership unexpectedly accepted")
	}
}
