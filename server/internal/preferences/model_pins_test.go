package preferences

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"mindfs/server/internal/agent"
)

func TestModelPinsIncludedInAgentStatusesWithoutOtherDefaults(t *testing.T) {
	store := &Store{path: filepath.Join(t.TempDir(), preferencesFileName)}
	if _, err := store.SetModelPinned("codex", "model-a", true); err != nil {
		t.Fatal(err)
	}
	statuses := []agent.Status{{Name: "codex"}, {Name: "claude"}}
	result := store.ApplyAgentDefaults(statuses)
	if !reflect.DeepEqual(result[0].PinnedModels, []string{"model-a"}) || len(result[1].PinnedModels) != 0 {
		t.Fatalf("statuses = %+v", result)
	}
	result[0].PinnedModels[0] = "mutated"
	if store.PinnedModels("codex")[0] != "model-a" || len(statuses[0].PinnedModels) != 0 {
		t.Fatal("status projection mutated source data")
	}
}

func TestModelPinsPersistenceIsolationAndDefaults(t *testing.T) {
	store := &Store{path: filepath.Join(t.TempDir(), preferencesFileName)}
	if _, err := store.UpdateAgentDefaultsIfChanged("codex", "original", "high", ""); err != nil {
		t.Fatal(err)
	}
	for _, agent := range []string{"codex", "claude"} {
		for range 2 {
			if _, err := store.SetModelPinned(agent, "model-a", true); err != nil {
				t.Fatal(err)
			}
		}
	}
	result, err := store.SetModelPinned("codex", "model-b", true)
	if err != nil {
		t.Fatal(err)
	}
	result[0] = "must-not-mutate-store"
	if _, err := store.SetModelPinned("codex", "model-a", false); err != nil {
		t.Fatal(err)
	}
	reloaded := &Store{path: store.path}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(reloaded.PinnedModels("codex"), []string{"model-b"}) || !reflect.DeepEqual(reloaded.PinnedModels("claude"), []string{"model-a"}) {
		t.Fatalf("pins = %+v", reloaded.data.AgentPinnedModels)
	}
	if defaults := reloaded.data.Agents["codex"]; defaults.Model != "original" || defaults.Effort != "high" {
		t.Fatalf("defaults changed: %+v", defaults)
	}
	copy := reloaded.PinnedModels("codex")
	copy[0] = "mutated"
	if reloaded.PinnedModels("codex")[0] != "model-b" {
		t.Fatal("getter returned mutable store data")
	}
}

func TestModelPinsConcurrentUpdates(t *testing.T) {
	store := &Store{path: filepath.Join(t.TempDir(), preferencesFileName)}
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := store.SetModelPinned("codex", fmt.Sprintf("model-%d", i), true); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if len(store.PinnedModels("codex")) != 20 {
		t.Fatal("concurrent pins lost")
	}
}

func TestModelPinsSaveFailureRollsBack(t *testing.T) {
	dir := t.TempDir()
	store := &Store{path: filepath.Join(dir, preferencesFileName)}
	if _, err := store.SetModelPinned("codex", "original", true); err != nil {
		t.Fatal(err)
	}
	blocked := filepath.Join(dir, "blocked")
	if err := os.WriteFile(blocked, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	store.path = filepath.Join(blocked, preferencesFileName)
	if _, err := store.SetModelPinned("codex", "extra", true); err == nil {
		t.Fatal("expected save failure")
	}
	if !reflect.DeepEqual(store.PinnedModels("codex"), []string{"original"}) {
		t.Fatal("failed save changed pins")
	}
}
