package preferences

import (
	"path/filepath"
	"testing"
)

func TestSessionNamingDefaultsPersistAndReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), preferencesFileName)
	store := &Store{
		path: path,
		data: UserPreferences{Agents: map[string]AgentDefaults{}},
	}
	if err := store.UpdateSessionNamingDefaults(" codex ", " gpt-5.4 "); err != nil {
		t.Fatalf("UpdateSessionNamingDefaults: %v", err)
	}
	if got := store.SessionNamingDefaults(); got != (SessionNamingDefaults{Agent: "codex", Model: "gpt-5.4"}) {
		t.Fatalf("SessionNamingDefaults = %#v", got)
	}

	reloaded := &Store{
		path: path,
		data: UserPreferences{Agents: map[string]AgentDefaults{}},
	}
	if err := reloaded.load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := reloaded.SessionNamingDefaults(); got != (SessionNamingDefaults{Agent: "codex", Model: "gpt-5.4"}) {
		t.Fatalf("reloaded SessionNamingDefaults = %#v", got)
	}
}

func TestSessionNamingDefaultsAllowDefaultModel(t *testing.T) {
	store := &Store{
		path: filepath.Join(t.TempDir(), preferencesFileName),
		data: UserPreferences{Agents: map[string]AgentDefaults{}},
	}
	if err := store.UpdateSessionNamingDefaults("codex", ""); err != nil {
		t.Fatalf("UpdateSessionNamingDefaults with default model: %v", err)
	}
	if got := store.SessionNamingDefaults(); got != (SessionNamingDefaults{Agent: "codex"}) {
		t.Fatalf("SessionNamingDefaults = %#v", got)
	}
	if err := store.UpdateSessionNamingDefaults("", "gpt-5.4"); err == nil {
		t.Fatal("UpdateSessionNamingDefaults without agent succeeded")
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
