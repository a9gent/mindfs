package gitview

import (
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func TestDecodeGitDiffOutputDecodesGB18030Text(t *testing.T) {
	source := "diff --git a/main.go b/main.go\n@@ -1 +1 @@\n-旧内容\n+新内容\n"
	encoded, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte(source))
	if err != nil {
		t.Fatalf("encode GB18030: %v", err)
	}

	got := decodeGitDiffOutput(encoded, ".go")
	if got != source {
		t.Fatalf("decoded diff = %q, want %q", got, source)
	}
}
