package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mindfs/server/internal/preferences"
	"mindfs/server/internal/testutil"
)

func TestModelPinsHandlers(t *testing.T) {
	testutil.IsolateUserDirs(t, t.TempDir())
	prefs, err := preferences.NewStore()
	if err != nil {
		t.Fatal(err)
	}
	h := &HTTPHandler{AppContext: &AppContext{Prefs: prefs}}
	for _, tc := range []struct {
		method, target, body string
		status               int
	}{
		{"PUT", "/api/preferences/model-pins", `{"agent":"codex","model":"a"}`, 400},
		{"PUT", "/api/preferences/model-pins", `{"agent":"codex","model":"","pinned":true}`, 400},
		{"PUT", "/api/preferences/model-pins", `{"agent":"codex","model":"a","pinned":true}`, 200},
		{"PUT", "/api/preferences/model-pins", `{"agent":"codex","model":"a","pinned":false}`, 200},
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(tc.method, tc.target, strings.NewReader(tc.body))
		h.handleModelPinsPut(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s: %d %s", tc.method, tc.body, w.Code, w.Body.String())
		}
	}
}

func TestModelPinsRoutesRequireProtection(t *testing.T) {
	router := (&HTTPHandler{AppContext: &AppContext{}}).Routes()
	for _, method := range []string{http.MethodPut} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(method, "/api/preferences/model-pins?agent=codex", strings.NewReader(`{"agent":"codex","model":"a","pinned":true}`)))
		if w.Code >= 200 && w.Code < 300 {
			t.Fatal("unprotected pin request accepted")
		}
		if w.Code == 404 || w.Code == 405 {
			t.Fatalf("missing protected route: %d", w.Code)
		}
	}
}
