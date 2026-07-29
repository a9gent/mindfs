package acp

import "testing"

func TestWindowsACPProcessCreationFlagsSuppressConsoleWindow(t *testing.T) {
	const (
		createNewProcessGroup  = uint32(0x00000200)
		createDefaultErrorMode = uint32(0x04000000)
		createNoWindow         = uint32(0x08000000)
	)

	flags := windowsACPProcessCreationFlags()
	if flags&createNewProcessGroup == 0 {
		t.Fatalf("windows ACP process flags = %#x, want CREATE_NEW_PROCESS_GROUP", flags)
	}
	if flags&createDefaultErrorMode == 0 {
		t.Fatalf("windows ACP process flags = %#x, want CREATE_DEFAULT_ERROR_MODE", flags)
	}
	if flags&createNoWindow == 0 {
		t.Fatalf("windows ACP process flags = %#x, want CREATE_NO_WINDOW to prevent startup console window during agent probe", flags)
	}
}
