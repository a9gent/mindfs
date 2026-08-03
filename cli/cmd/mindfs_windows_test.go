//go:build windows

package main

import (
	"os"
	"strings"
	"testing"
)

func TestProcessNameForCurrentPID(t *testing.T) {
	name, err := processNameForPID(os.Getpid())
	if err != nil {
		t.Fatalf("processNameForPID(%d) returned error: %v", os.Getpid(), err)
	}
	if !strings.HasSuffix(strings.ToLower(name), ".exe") {
		t.Fatalf("processNameForPID(%d) = %q, want an executable name", os.Getpid(), name)
	}
	if !processExistsPlatform(os.Getpid()) {
		t.Fatalf("current process %d was reported as stopped", os.Getpid())
	}
}
