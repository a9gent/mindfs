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
