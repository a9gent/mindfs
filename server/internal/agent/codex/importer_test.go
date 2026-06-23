package codex

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReadCodexImportedExchangeLocatorsAppliesRollbackBeforeTimestampFilter(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout.jsonl")
	content := `{"timestamp":"2026-06-22T01:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"u1"}]}}
{"timestamp":"2026-06-22T01:00:01Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1"}]}}
{"timestamp":"2026-06-22T01:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"u2"}]}}
{"timestamp":"2026-06-22T01:00:03Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2"}]}}
{"timestamp":"2026-06-22T01:00:04Z","type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}
{"timestamp":"2026-06-22T01:00:05Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"u3"}]}}
{"timestamp":"2026-06-22T01:00:06Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a3"}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	all, err := readCodexImportedExchangeLocators(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 4 {
		t.Fatalf("len(all) = %d, want 4", len(all))
	}
	if all[0].Content != "u1" || all[1].Content != "a1" || all[2].Content != "u3" || all[3].Content != "a3" {
		t.Fatalf("effective exchanges = %#v", all)
	}
	if all[3].CodexUserCountAfter != 2 {
		t.Fatalf("a3 user count = %d, want 2", all[3].CodexUserCountAfter)
	}

	after, err := time.Parse(time.RFC3339, "2026-06-22T01:00:01Z")
	if err != nil {
		t.Fatal(err)
	}
	delta, err := readCodexImportedExchangeLocators(path, after)
	if err != nil {
		t.Fatal(err)
	}
	if len(delta) != 2 {
		t.Fatalf("len(delta) = %d, want 2", len(delta))
	}
	if delta[0].Content != "u3" || delta[1].Content != "a3" {
		t.Fatalf("delta exchanges = %#v", delta)
	}
}
