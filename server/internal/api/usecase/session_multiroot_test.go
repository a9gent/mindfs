package usecase

import (
	"context"
	"errors"
	"testing"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	rootfs "mindfs/server/internal/fs"
	"mindfs/server/internal/logthrottle"
	"mindfs/server/internal/preferences"
	"mindfs/server/internal/session"
	"mindfs/server/internal/testutil"
)

// multiRootTestRegistry serves several roots and can make one of them unhealthy,
// which is how a root with an unreadable path or a corrupt session index behaves.
type multiRootTestRegistry struct {
	roots    map[string]rootfs.RootInfo
	order    []string
	managers map[string]*session.Manager
}

func (r *multiRootTestRegistry) GetRoot(rootID string) (rootfs.RootInfo, error) {
	if root, ok := r.roots[rootID]; ok {
		return root, nil
	}
	return rootfs.RootInfo{}, errors.New("root not found")
}

func (r *multiRootTestRegistry) GetSessionManager(rootID string) (*session.Manager, error) {
	manager, ok := r.managers[rootID]
	if !ok {
		return nil, errors.New("session store unavailable for " + rootID)
	}
	return manager, nil
}

func (r *multiRootTestRegistry) ListRoots() []rootfs.RootInfo {
	out := make([]rootfs.RootInfo, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.roots[id])
	}
	return out
}

func (r *multiRootTestRegistry) UpsertRoot(string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}
func (r *multiRootTestRegistry) RemoveRoot(string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}
func (r *multiRootTestRegistry) RenameRoot(string, string, string) (rootfs.RootInfo, error) {
	return rootfs.RootInfo{}, nil
}
func (r *multiRootTestRegistry) GetAgentPool() *agent.Pool                { return nil }
func (r *multiRootTestRegistry) GetPreferences() *preferences.Store       { return nil }
func (r *multiRootTestRegistry) GetProber() *agent.Prober                 { return nil }
func (r *multiRootTestRegistry) GetCandidateRegistry() *CandidateRegistry { return nil }
func (r *multiRootTestRegistry) ReleaseFileWatcher(string, string)        {}

func (r *multiRootTestRegistry) GetExternalSessionImporter(string) (agenttypes.ExternalSessionImporter, error) {
	return nil, errors.New("not available")
}

func (r *multiRootTestRegistry) GetFileWatcher(string, *session.Manager) (*rootfs.SharedFileWatcher, error) {
	return nil, errors.New("not available")
}

func newMultiRootTestService(t *testing.T) (Service, *multiRootTestRegistry, *session.Manager) {
	t.Helper()
	logthrottle.Reset()
	testutil.IsolateUserDirs(t, t.TempDir())

	// The unhealthy root is listed first so a failure there cannot be masked by
	// the healthy root being processed earlier.
	broken := rootfs.NewRootInfo("broken", "broken", t.TempDir())
	healthy := rootfs.NewRootInfo("healthy", "healthy", t.TempDir())
	manager := session.NewManager(healthy)
	registry := &multiRootTestRegistry{
		roots:    map[string]rootfs.RootInfo{"broken": broken, "healthy": healthy},
		order:    []string{"broken", "healthy"},
		managers: map[string]*session.Manager{"healthy": manager},
	}
	return Service{Registry: registry}, registry, manager
}

func TestListMultiRootSessionsSkipsUnhealthyRoot(t *testing.T) {
	service, _, manager := newMultiRootTestService(t)
	if _, err := manager.Create(context.Background(), session.CreateInput{
		Type:  session.TypeChat,
		Agent: "codex",
		Name:  "healthy session",
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	out, err := service.ListMultiRootSessions(context.Background(), ListMultiRootSessionsInput{LimitPerRoot: 5})
	if err != nil {
		t.Fatalf("one unhealthy root must not fail the whole list, got %v", err)
	}
	if len(out.Groups) != 1 {
		t.Fatalf("groups = %d, want 1", len(out.Groups))
	}
	group := out.Groups[0]
	if group.RootID != "healthy" {
		t.Fatalf("group root = %q, want healthy", group.RootID)
	}
	if group.TotalCount != 1 || len(group.Sessions) != 1 {
		t.Fatalf("group total = %d, sessions = %d, want 1 and 1", group.TotalCount, len(group.Sessions))
	}
}

func TestSearchSessionsMultiRootSkipsUnhealthyRoot(t *testing.T) {
	service, _, manager := newMultiRootTestService(t)
	if _, err := manager.Create(context.Background(), session.CreateInput{
		Type:  session.TypeChat,
		Agent: "codex",
		Name:  "searchable",
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	out, err := service.SearchSessions(context.Background(), SearchSessionsInput{
		Query:     "searchable",
		Limit:     10,
		MultiRoot: true,
	})
	if err != nil {
		t.Fatalf("one unhealthy root must not fail multi-root search, got %v", err)
	}
	for _, hit := range out.Items {
		if hit.RootID == "broken" {
			t.Fatalf("hit from unhealthy root: %+v", hit)
		}
	}
}

func TestListSessionsStillReportsUnknownRoot(t *testing.T) {
	service, _, _ := newMultiRootTestService(t)
	if _, err := service.ListSessions(context.Background(), ListSessionsInput{RootID: "missing"}); err == nil {
		t.Fatal("single-root listing must still fail loudly for an unknown root")
	}
}
