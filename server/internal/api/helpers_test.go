package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"mindfs/server/internal/apperr"
)

func TestRespondErrorIncludesAppErrorFields(t *testing.T) {
	rec := httptest.NewRecorder()
	respondError(rec, http.StatusBadRequest, apperr.Wrap("open", "/private/session.jsonl", os.ErrPermission))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["code"] != apperr.CodePermissionDenied {
		t.Fatalf("code = %v", payload["code"])
	}
	if payload["operation"] != "open" {
		t.Fatalf("operation = %v", payload["operation"])
	}
	if payload["path"] != "/private/session.jsonl" {
		t.Fatalf("path = %v", payload["path"])
	}
	if payload["message"] == "" || payload["detail"] == "" || payload["error"] == "" {
		t.Fatalf("missing expected message fields: %#v", payload)
	}
}
