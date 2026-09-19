package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"mindfs/server/internal/e2ee"
	"mindfs/server/internal/fs"
)

func TestFileEditingHTTPAndEncryption(t *testing.T) {
	for _, encrypted := range []bool{false, true} {
		name := "plain"
		if encrypted {
			name = "encrypted"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			registry := fs.NewRegistry(filepath.Join(t.TempDir(), "registry.json"))
			root, err := registry.Upsert(dir)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			app := &AppContext{Dirs: registry}
			t.Cleanup(func() {
				for _, ctx := range app.roots {
					if ctx.Watcher != nil {
						ctx.Watcher.Close()
					}
				}
			})
			key := []byte("0123456789abcdef0123456789abcdef")
			if encrypted {
				app.E2EE = e2ee.NewManager(e2ee.Config{Enabled: true, NodeID: "node", PairingSecret: "test-secret"})
				if _, err := app.E2EE.OpenSessionForClient("test-client", e2ee.DerivedKey{Transport: key}); err != nil {
					t.Fatal(err)
				}
			}
			handler := (&HTTPHandler{AppContext: app}).Routes()
			target := "/api/file?" + url.Values{"root": {root.ID}, "path": {"notes.txt"}}.Encode()
			request := func(method, target string, payload any, authorized bool) (int, map[string]json.RawMessage) {
				t.Helper()
				var body []byte
				if payload != nil {
					if encrypted && authorized {
						envelope, err := e2ee.EncryptJSON(key, payload)
						if err != nil {
							t.Fatal(err)
						}
						body, _ = json.Marshal(envelope)
					} else {
						body, _ = json.Marshal(payload)
					}
				}
				req := httptest.NewRequest(method, target, bytes.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				if encrypted && authorized {
					ts := time.Now().UTC().Format(time.RFC3339)
					req.Header.Set(e2eeHeaderName, "1")
					req.Header.Set(clientIDHeaderName, "test-client")
					req.Header.Set(e2eeTSHeaderName, ts)
					req.Header.Set(e2eeProofHeaderName, e2ee.BuildRequestProof(key, method, target, ts, "test-client"))
				}
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, req)
				var result map[string]json.RawMessage
				if response.Header().Get(e2eeHeaderName) == "1" {
					var envelope e2ee.CipherEnvelope
					if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
						t.Fatal(err)
					}
					if err := e2ee.DecryptJSON(key, &envelope, &result); err != nil {
						t.Fatal(err)
					}
				} else if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
					t.Fatalf("response: %s (%v)", response.Body.String(), err)
				}
				return response.Code, result
			}
			if encrypted {
				for _, method := range []string{"GET", "PUT"} {
					path := target
					var body any
					if method == "GET" {
						path += "&edit=1"
					} else {
						body = map[string]any{"content": "bad", "base_revision": "bad"}
					}
					if status, _ := request(method, path, body, false); status != http.StatusUnauthorized {
						t.Fatalf("unprotected %s accepted: %d", method, status)
					}
				}
			}
			status, payload := request("GET", target+"&edit=1", nil, true)
			if status != 200 {
				t.Fatalf("read status: %d %s", status, payload)
			}
			var file fs.ReadResult
			if err := json.Unmarshal(payload["file"], &file); err != nil {
				t.Fatal(err)
			}
			if file.Content != "original" || file.Revision == "" {
				t.Fatalf("read file: %+v", file)
			}
			status, _ = request("PUT", target, map[string]any{"content": "中文\r\n", "base_revision": file.Revision}, true)
			if status != 200 {
				t.Fatalf("save status: %d", status)
			}
			status, _ = request("PUT", target, map[string]any{"content": "stale", "base_revision": file.Revision}, true)
			if status != 409 {
				t.Fatalf("conflict status: %d", status)
			}
			data, _ := os.ReadFile(filepath.Join(dir, "notes.txt"))
			if string(data) != "中文\r\n" {
				t.Fatalf("content: %q", data)
			}
			status, _ = request("PUT", target, map[string]any{"base_revision": file.Revision}, true)
			if status != 400 {
				t.Fatalf("missing content accepted: %d", status)
			}
		})
	}
}
