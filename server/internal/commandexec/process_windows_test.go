//go:build windows

package commandexec

import "testing"

func TestWindowsPipeDecodeSelection(t *testing.T) {
	if shouldDecodeWindowsPipeOutput("cmd.exe") {
		t.Fatalf("cmd output is forced to UTF-8 with chcp 65001 and should not be GB18030 decoded")
	}
	if !shouldDecodeWindowsPipeOutput("powershell.exe") {
		t.Fatalf("Windows PowerShell 5.1 output should be GB18030 decoded")
	}
	if shouldDecodeWindowsPipeOutput("pwsh") {
		t.Fatalf("pwsh output should remain UTF-8")
	}
}

func TestWindowsLongShellStdoutDecodeSelection(t *testing.T) {
	if shouldDecodeWindowsLongShellStdout("cmd.exe") {
		t.Fatalf("cmd long shell output is forced to UTF-8 with chcp 65001 and should not be GB18030 decoded")
	}
	if !shouldDecodeWindowsLongShellStdout("powershell.exe") {
		t.Fatalf("Windows PowerShell 5.1 stdout should be GB18030 decoded")
	}
	if shouldDecodeWindowsLongShellStdout("pwsh") {
		t.Fatalf("pwsh long shell output should remain UTF-8")
	}
}
