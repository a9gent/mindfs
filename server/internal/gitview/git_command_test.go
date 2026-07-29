package gitview

import "testing"

func TestWindowsGitCreationFlagsSuppressConsoleWindow(t *testing.T) {
	const (
		createNewProcessGroup  = uint32(0x00000200)
		createDefaultErrorMode = uint32(0x04000000)
		createNoWindow         = uint32(0x08000000)
	)

	flags := windowsGitCreationFlags()
	if flags&createNewProcessGroup == 0 {
		t.Fatalf("windows git flags = %#x, want CREATE_NEW_PROCESS_GROUP", flags)
	}
	if flags&createDefaultErrorMode == 0 {
		t.Fatalf("windows git flags = %#x, want CREATE_DEFAULT_ERROR_MODE", flags)
	}
	if flags&createNoWindow == 0 {
		t.Fatalf("windows git flags = %#x, want CREATE_NO_WINDOW to prevent console flashes from detached service", flags)
	}
}
