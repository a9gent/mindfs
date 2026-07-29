package main

import "testing"

func TestWindowsBrowserCreationFlagsSuppressConsoleWindow(t *testing.T) {
	const createNoWindow = uint32(0x08000000)

	flags := windowsBrowserCreationFlags()
	if flags&createNoWindow == 0 {
		t.Fatalf("windows browser opener flags = %#x, want CREATE_NO_WINDOW to prevent startup console window", flags)
	}
}
