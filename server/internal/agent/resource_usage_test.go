package agent

import (
	"os"
	"testing"
)

func TestCollectSingleProcessReportsCurrentProcess(t *testing.T) {
	claimed := make(map[int32]struct{})
	usage := processTreeUsage{}
	collectSingleProcess(int32(os.Getpid()), claimed, &usage)
	if usage.count != 1 {
		t.Fatalf("process count = %d, want 1", usage.count)
	}
	if usage.bytes == 0 {
		t.Fatal("current process RSS is zero")
	}
	collectSingleProcess(int32(os.Getpid()), claimed, &usage)
	if usage.count != 1 {
		t.Fatalf("deduplicated process count = %d, want 1", usage.count)
	}
}
