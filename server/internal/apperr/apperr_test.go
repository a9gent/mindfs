package apperr

import (
	"errors"
	"os"
	"testing"
)

func TestWrapPermissionDenied(t *testing.T) {
	err := Wrap("open", `C:\Users\me\.agent\session.jsonl`, os.ErrPermission)
	var appErr *Error
	if !errors.As(err, &appErr) {
		t.Fatalf("expected file error, got %T", err)
	}
	if appErr.Code != CodePermissionDenied {
		t.Fatalf("code = %q, want %q", appErr.Code, CodePermissionDenied)
	}
	if appErr.Path == "" || appErr.Op != "open" {
		t.Fatalf("missing path/op: %#v", appErr)
	}
}

func TestClassifyWindowsAccessDeniedText(t *testing.T) {
	appErr, ok := Classify(errors.New("CreateFile C:\\secret: Access is denied."))
	if !ok {
		t.Fatal("expected classification")
	}
	if appErr.Code != CodePermissionDenied {
		t.Fatalf("code = %q, want %q", appErr.Code, CodePermissionDenied)
	}
}
