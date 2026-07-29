package main

import "testing"

func TestWindowsBackgroundCreationFlagsDetachFromConsole(t *testing.T) {
	const (
		createNewProcessGroup = uint32(0x00000200)
		detachedProcess       = uint32(0x00000008)
	)

	flags := windowsBackgroundCreationFlags()
	if flags&createNewProcessGroup == 0 {
		t.Fatalf("windows background process flags = %#x, want CREATE_NEW_PROCESS_GROUP", flags)
	}
	if flags&detachedProcess == 0 {
		t.Fatalf("windows background process flags = %#x, want DETACHED_PROCESS so the service is not tied to the launching terminal", flags)
	}
}
