package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/kanban"
	"mindfs/server/internal/session"
)

// The three-way delete dialog is driven entirely by this contract: a delete
// without an explicit choice must never mutate anything and must report the
// real child count, because the client's own count can be undercounted by
// filters and pagination.
func TestHTTPSessionDeleteRequiresChoiceForSessionsWithChildren(t *testing.T) {
	registry := fs.NewRegistry(filepath.Join(t.TempDir(), "registry.json"))
	root, err := registry.Upsert(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := &AppContext{Dirs: registry}
	// DeleteSession asks the kanban service to clean up task groups, so a bare
	// AppContext makes every delete fail with "kanban service not configured".
	app.Kanban = kanban.NewService(kanban.NewTemplateStoreAt(t.TempDir()), app)
	manager, err := app.GetSessionManager(root.ID)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	parent, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, Agent: "codex", Model: "test-model"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, Agent: "codex", Model: "test-model"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetParentSession(ctx, child.Key, parent.Key); err != nil {
		t.Fatal(err)
	}

	router := chi.NewRouter()
	h := &HTTPHandler{AppContext: app}
	router.Delete("/api/sessions/{key}", h.handleSessionDelete)

	deleteSession := func(query string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodDelete, "/api/sessions/"+parent.Key+"?root="+root.ID+query, nil)
		router.ServeHTTP(w, req)
		return w
	}

	w := deleteSession("")
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusConflict, w.Body.String())
	}
	var payload struct {
		Error      string `json:"error"`
		ChildCount int    `json:"child_count"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode 409 body: %v; body=%s", err, w.Body.String())
	}
	if payload.Error != "delete_needs_choice" || payload.ChildCount != 1 {
		t.Fatalf("payload = %#v, want delete_needs_choice with child_count=1", payload)
	}
	if _, err := manager.Get(ctx, parent.Key, 0); err != nil {
		t.Fatalf("parent was deleted despite the 409: %v", err)
	}
	if _, err := manager.Get(ctx, child.Key, 0); err != nil {
		t.Fatalf("child was deleted despite the 409: %v", err)
	}

	if w := deleteSession("&keep_children=true&cascade=true"); w.Code != http.StatusBadRequest {
		t.Fatalf("contradictory flags: status = %d, want %d", w.Code, http.StatusBadRequest)
	}

	if w := deleteSession("&cascade=true"); w.Code != http.StatusNoContent {
		t.Fatalf("cascade delete: status = %d, want %d; body=%s", w.Code, http.StatusNoContent, w.Body.String())
	}
	if _, err := manager.Get(ctx, child.Key, 0); err == nil {
		t.Fatal("child survived an explicit cascade delete")
	}
}

func TestHTTPSessionParentTreatsEmptyBodyAsDetach(t *testing.T) {
	registry := fs.NewRegistry(filepath.Join(t.TempDir(), "registry.json"))
	root, err := registry.Upsert(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := &AppContext{Dirs: registry}
	// DeleteSession asks the kanban service to clean up task groups, so a bare
	// AppContext makes every delete fail with "kanban service not configured".
	app.Kanban = kanban.NewService(kanban.NewTemplateStoreAt(t.TempDir()), app)
	manager, err := app.GetSessionManager(root.ID)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	parent, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, Agent: "codex", Model: "test-model"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, Agent: "codex", Model: "test-model"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetParentSession(ctx, child.Key, parent.Key); err != nil {
		t.Fatal(err)
	}

	router := chi.NewRouter()
	h := &HTTPHandler{AppContext: app}
	router.Post("/api/sessions/{key}/parent", h.handleSessionParent)

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/sessions/"+child.Key+"/parent?root="+root.ID, http.NoBody))
	if w.Code != http.StatusOK {
		t.Fatalf("empty body detach: status = %d; body=%s", w.Code, w.Body.String())
	}
	detached, err := manager.Get(ctx, child.Key, 0)
	if err != nil {
		t.Fatal(err)
	}
	if detached.ParentSessionKey != "" {
		t.Fatalf("parent_session_key = %q, want empty", detached.ParentSessionKey)
	}

	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/sessions/missing/parent?root="+root.ID, http.NoBody))
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing session: status = %d, want %d; body=%s", w.Code, http.StatusNotFound, w.Body.String())
	}
}
