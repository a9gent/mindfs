package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"mindfs/server/internal/fs"
)

func TestHandleViewRoutesIsReachable(t *testing.T) {
	tempDir := t.TempDir()
	root := filepath.Join(tempDir, "mindfs")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir root: %v", err)
	}
	name := filepath.Base(root)
	if _, err := fs.NewRootInfo(name, name, root).EnsureMetaDir(); err != nil {
		t.Fatalf("ensure managed dir: %v", err)
	}

	registry := fs.NewRegistry(filepath.Join(tempDir, "registry.json"))
	if _, err := registry.Upsert(root); err != nil {
		t.Fatalf("upsert registry dir: %v", err)
	}

	handler := &HTTPHandler{
		AppContext: &AppContext{
			Dirs: registry,
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/view/routes?root=mindfs", nil)
	rec := httptest.NewRecorder()
	handler.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if _, ok := body["routes"]; !ok {
		t.Fatalf("expected response to include routes field, got: %v", body)
	}
}
