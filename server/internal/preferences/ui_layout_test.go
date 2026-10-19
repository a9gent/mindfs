package preferences

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUILayoutUnsetIsDistinguishableFromFalse(t *testing.T) {
	s := &Store{path: filepath.Join(t.TempDir(), "preferences.json")}
	layout := s.UILayout()
	if layout.Configured {
		t.Fatal("empty store must report the layout as unconfigured")
	}
	if layout.SidebarsSwapped || layout.GitDiffSideBySide {
		t.Fatalf("unexpected defaults: %+v", layout)
	}
}

func TestUILayoutPersistsExplicitFalse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "preferences.json")
	s := &Store{path: path}
	if err := s.UpdateUILayout(true, true); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateUILayout(false, false); err != nil {
		t.Fatal(err)
	}
	reloaded := &Store{path: path}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	layout := reloaded.UILayout()
	if !layout.Configured {
		t.Fatal("storing explicit false must still count as configured")
	}
	if layout.SidebarsSwapped || layout.GitDiffSideBySide {
		t.Fatalf("unexpected values after reload: %+v", layout)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "sidebars_swapped") {
		t.Fatalf("explicit false was dropped from the payload: %s", raw)
	}
}

func TestUILayoutReloadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "preferences.json")
	s := &Store{path: path}
	if err := s.UpdateUILayout(true, false); err != nil {
		t.Fatal(err)
	}
	reloaded := &Store{path: path}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	layout := reloaded.UILayout()
	if !layout.Configured || !layout.SidebarsSwapped || layout.GitDiffSideBySide {
		t.Fatalf("round trip mismatch: %+v", layout)
	}
}

func TestUILayoutNilStoreIsSafe(t *testing.T) {
	var s *Store
	if s.UILayout().Configured {
		t.Fatal("nil store must report unconfigured")
	}
	if err := s.UpdateUILayout(true, true); err != nil {
		t.Fatalf("nil store update: %v", err)
	}
}
