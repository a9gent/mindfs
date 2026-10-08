package preferences

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLauncherNodesPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "preferences.json")
	s := &Store{path: path}
	nodes := []LauncherNode{{ID: "b", Name: "B", URL: "https://b.example/n/b/", CreatedAt: "2026-10-08T00:00:00Z"}}
	if err := s.UpdateLauncherNodes(nodes); err != nil {
		t.Fatal(err)
	}
	nodes[0].Name = "changed"
	reloaded := &Store{path: path}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	if got := reloaded.LauncherNodes(); len(got) != 1 || got[0].Name != "B" {
		t.Fatalf("unexpected nodes: %+v", got)
	}
	got := s.LauncherNodes()
	got[0].Name = "changed"
	if s.LauncherNodes()[0].Name != "B" {
		t.Fatal("getter leaked mutable data")
	}
	invalid := []LauncherNode{{ID: "x", Name: "X", URL: "javascript:alert(1)", CreatedAt: "now"}}
	if err := s.UpdateLauncherNodes(invalid); err == nil {
		t.Fatal("accepted invalid URL")
	}
	if err := s.UpdateLauncherNodes(append(s.LauncherNodes(), s.LauncherNodes()...)); err == nil {
		t.Fatal("accepted duplicate")
	}
	if err := s.UpdateLauncherNodes([]LauncherNode{}); err != nil {
		t.Fatal(err)
	}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	if len(reloaded.LauncherNodes()) != 0 {
		t.Fatal("deletion not persisted")
	}
}

func TestLauncherNodesSaveFailure(t *testing.T) {
	s := &Store{path: t.TempDir()}
	if err := os.WriteFile(filepath.Join(s.path, "block-removal"), []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	err := s.UpdateLauncherNodes([]LauncherNode{{ID: "x", Name: "X", URL: "https://x.example", CreatedAt: "now"}})
	if err == nil {
		t.Fatal("expected write failure")
	}
	if len(s.LauncherNodes()) != 0 {
		t.Fatal("failed write changed memory")
	}
}
