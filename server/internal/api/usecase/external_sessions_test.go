package usecase

import (
	"testing"

	agenttypes "mindfs/server/internal/agent/types"
)

func TestExternalSessionDeltaAfterCtxSeqSkipsCopiedPrefix(t *testing.T) {
	exchanges := []agenttypes.ImportedExchange{
		{Role: "user", Content: "u1"},
		{Role: "agent", Content: "a1"},
		{Role: "user", Content: "u2"},
		{Role: "agent", Content: "a2"},
	}
	delta := externalSessionDeltaAfterCtxSeq(exchanges, 2)
	if len(delta) != 2 {
		t.Fatalf("len(delta) = %d, want 2", len(delta))
	}
	if delta[0].Content != "u2" || delta[1].Content != "a2" {
		t.Fatalf("delta = %#v", delta)
	}
}

func TestExternalSessionDeltaAfterCtxSeqReturnsEmptyWhenFullySynced(t *testing.T) {
	exchanges := []agenttypes.ImportedExchange{
		{Role: "user", Content: "u1"},
		{Role: "agent", Content: "a1"},
	}
	if delta := externalSessionDeltaAfterCtxSeq(exchanges, 2); len(delta) != 0 {
		t.Fatalf("delta = %#v, want empty", delta)
	}
}
