package claude

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestIncrementalClaudeHistoryMatchesColdParse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	prefix := `{"type":"assistant","timestamp":"2026-07-28T01:00:01Z","message":{"content":[{"type":"tool_use","id":"ask-1","name":"AskUserQuestion","input":{"questions":[{"question":"Continue?","options":[{"label":"Yes"}]}]}}]}}
`
	if err := os.WriteFile(path, []byte(prefix), 0600); err != nil {
		t.Fatal(err)
	}
	initial, err := readClaudeImportedExchanges(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	initial[0].Aux[0].ToolCall.Meta["questionCount"] = 999
	tail := `{"type":"user","timestamp":"2026-07-28T01:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"ask-1","content":"Yes"}]},"toolUseResult":{"questions":[{"question":"Continue?"}],"answers":{"Continue?":"Yes"}}}
{"type":"assistant","timestamp":"2026-07-28T01:00:03Z","uuid":"final-id","message":{"content":[{"type":"text","text":"done"}]}}
`
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString(tail)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	warm, err := readClaudeImportedExchangeLocators(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	claudeHistoryCache.Forget(path)
	cold, err := readClaudeImportedExchangeLocators(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(warm, cold) {
		t.Fatalf("incremental differs from full parse:\nwarm %#v\ncold %#v", warm, cold)
	}
	if warm[0].Aux[0].ToolCall.Meta["questionCount"] != 1 {
		t.Fatal("snapshot mutated parser metadata")
	}
}
