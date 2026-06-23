package main

import (
	"errors"
	"os"
	"testing"
)

func TestParseTasklistImageName(t *testing.T) {
	name, err := parseTasklistImageName([]byte(`"mindfs.exe","21560","Console","1","18,244 K"`), 21560)
	if err != nil {
		t.Fatalf("parseTasklistImageName returned error: %v", err)
	}
	if name != "mindfs.exe" {
		t.Fatalf("expected mindfs.exe, got %q", name)
	}
}

func TestParseTasklistImageNameRejectsLocalizedNoTaskMessage(t *testing.T) {
	_, err := parseTasklistImageName([]byte("信息: 没有运行的任务匹配指定标准。\r\n"), 21560)
	if !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("expected os.ErrProcessDone, got %v", err)
	}
}

func TestParseTasklistImageNameRejectsMismatchedPID(t *testing.T) {
	_, err := parseTasklistImageName([]byte(`"mindfs.exe","21561","Console","1","18,244 K"`), 21560)
	if !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("expected os.ErrProcessDone, got %v", err)
	}
}
