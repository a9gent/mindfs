package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"mindfs/server/internal/api/usecase"
	"mindfs/server/internal/fs"
)

func TestUploadLargeFile(t *testing.T) {
	const size = 220 << 20
	multipartTempDir := t.TempDir()
	t.Setenv("TMPDIR", multipartTempDir)
	dir := t.TempDir()
	registry := fs.NewRegistry(filepath.Join(t.TempDir(), "registry.json"))
	root, err := registry.Upsert(dir)
	if err != nil {
		t.Fatal(err)
	}
	app := &AppContext{Dirs: registry}
	t.Cleanup(func() {
		for _, root := range app.roots {
			if root.Watcher != nil {
				root.Watcher.Close()
			}
		}
	})

	// Stream a sparse file so the test does not buffer a large request in memory.
	source, err := os.CreateTemp(t.TempDir(), "upload-source-*")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err := source.Truncate(size); err != nil {
		t.Fatal(err)
	}
	if _, err := source.WriteAt([]byte("large upload start"), 0); err != nil {
		t.Fatal(err)
	}
	if _, err := source.WriteAt([]byte("large upload end"), size-16); err != nil {
		t.Fatal(err)
	}
	wantHash := sha256.New()
	if _, err := io.Copy(wantHash, source); err != nil {
		t.Fatal(err)
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	var envelope bytes.Buffer
	form := multipart.NewWriter(&envelope)
	if err := form.WriteField("dir", "uploads"); err != nil {
		t.Fatal(err)
	}
	if _, err := form.CreateFormFile("files", "large.bin"); err != nil {
		t.Fatal(err)
	}
	prefix := append([]byte(nil), envelope.Bytes()...)
	envelope.Reset()
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/upload?root="+root.ID,
		io.MultiReader(bytes.NewReader(prefix), source, bytes.NewReader(envelope.Bytes())))
	req.Header.Set("Content-Type", form.FormDataContentType())
	resp := httptest.NewRecorder()
	(&HTTPHandler{AppContext: app}).Routes().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("upload %d bytes: status %d, body %s", size, resp.Code, resp.Body.String())
	}
	var result struct {
		Files []usecase.UploadedFile `json:"files"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Files) != 1 || result.Files[0].Size != size || result.Files[0].Path != "uploads/large.bin" {
		t.Fatalf("unexpected uploaded files: %+v", result.Files)
	}
	saved, err := os.Open(filepath.Join(dir, "uploads", "large.bin"))
	if err != nil {
		t.Fatal(err)
	}
	defer saved.Close()
	gotHash := sha256.New()
	if _, err := io.Copy(gotHash, saved); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotHash.Sum(nil), wantHash.Sum(nil)) {
		t.Fatal("uploaded file content differs from source")
	}
	entries, err := os.ReadDir(multipartTempDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("multipart temporary files were not removed: %v", entries)
	}
}

func TestUploadRejectsMalformedMultipart(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/upload?root=test", bytes.NewBufferString("broken"))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=test")
	resp := httptest.NewRecorder()
	(&HTTPHandler{AppContext: &AppContext{}}).handleUpload(resp, req)
	if resp.Code != http.StatusBadRequest || !bytes.Contains(resp.Body.Bytes(), []byte("invalid multipart form")) {
		t.Fatalf("unexpected response: %d %s", resp.Code, resp.Body.String())
	}
}
