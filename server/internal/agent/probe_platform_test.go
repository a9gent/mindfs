package agent

import "testing"

func TestBackgroundRuntimeProbeDisabledOnWindows(t *testing.T) {
	if shouldRunBackgroundRuntimeProbe("windows") {
		t.Fatalf("Windows startup should not run background runtime probes that spawn agent CLI windows")
	}
	if !shouldRunBackgroundRuntimeProbe("darwin") {
		t.Fatalf("darwin should keep background runtime probes enabled")
	}
	if !shouldRunBackgroundRuntimeProbe("linux") {
		t.Fatalf("linux should keep background runtime probes enabled")
	}
}
