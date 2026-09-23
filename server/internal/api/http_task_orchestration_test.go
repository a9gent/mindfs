package api

import (
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLocalCLITaskOrchestrationPaths(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		want         bool
	}{
		{"GET", "/api/task-groups", true}, {"POST", "/api/task-groups", true}, {"PATCH", "/api/task-groups/id", false}, {"POST", "/api/task-groups/id/publish", true}, {"POST", "/api/task-groups/id/approve-plan", false},
		{"GET", "/api/tasks", true}, {"GET", "/api/agents", true}, {"POST", "/api/tasks", true}, {"PATCH", "/api/tasks/id", true}, {"DELETE", "/api/tasks/id", true},
		{"POST", "/api/tasks/id/orchestration/to-task", true}, {"POST", "/api/tasks/id/orchestration/approve-plan", false}, {"PATCH", "/api/preferences", false},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		if got := isLocalCLIPath(r); got != tc.want {
			t.Errorf("%s %s: %v", tc.method, tc.path, got)
		}
	}
}
func TestCLICannotApproveFirstGroupPlan(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/api/task-groups/id/approve-plan", nil)
	r.Header.Set(localCLIHeaderName, "test-cli")
	router := chi.NewRouter()
	h := &HTTPHandler{}
	router.Post("/api/task-groups/{id}/{operation}", h.handleTaskGroupAction)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status=%d", w.Code)
	}
}

func TestLegacyTaskOperationsAreUnavailable(t *testing.T) {
	router := chi.NewRouter()
	h := &HTTPHandler{}
	router.Post("/api/tasks/{id}/orchestration/{operation}", h.handleTaskOrchestration)
	for _, operation := range []string{"publish", "approve-plan", "complete"} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/tasks/id/orchestration/"+operation, nil))
		if w.Code != http.StatusNotFound {
			t.Fatalf("legacy operation %s still routed: %d", operation, w.Code)
		}
	}
}
