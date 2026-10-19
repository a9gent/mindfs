package codex

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestIncrementalCodexHistoryMatchesColdParse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	prefix := `{"timestamp":"2026-07-28T01:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"run"}]}}
{"timestamp":"2026-07-28T01:00:02Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call-1","arguments":"{\"cmd\":\"echo ok\"}"}}
`
	if err := os.WriteFile(path, []byte(prefix), 0600); err != nil {
		t.Fatal(err)
	}
	initial, err := readCodexImportedExchanges(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	initial[1].Aux[0].ToolCall.Title = "caller mutation"
	tails := []string{
		`{"timestamp":"2026-07-28T01:00:03Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"{\"output\":\"ok\",\"exit_code\":0}"}}
{"timestamp":"2026-07-28T01:00:04Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}
`,
		`{"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}
{"timestamp":"2026-07-28T01:00:05Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"replacement"}]}}
`,
	}
	for _, tail := range tails {
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.WriteString(tail)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		warm, err := readCodexImportedExchangeLocators(path, time.Time{})
		if err != nil {
			t.Fatal(err)
		}
		codexHistoryCache.Forget(path)
		cold, err := readCodexImportedExchangeLocators(path, time.Time{})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(warm, cold) {
			t.Fatalf("incremental differs from full parse:\nwarm %#v\ncold %#v", warm, cold)
		}
	}
}

func BenchmarkCodexAppendedHistory(b *testing.B) {
	path := filepath.Join(b.TempDir(), "history.jsonl")
	turn := `{"timestamp":"2026-07-28T01:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"question"}]}}
{"timestamp":"2026-07-28T01:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}}
`
	prefix := strings.Repeat(turn, 2000)
	tail := strings.ReplaceAll(turn, "01:00:", "02:00:")
	after := time.Date(2026, 7, 28, 1, 30, 0, 0, time.UTC)
	for _, incremental := range []bool{false, true} {
		name := "full"
		if incremental {
			name = "incremental"
		}
		b.Run(name, func(b *testing.B) {
			for n := 0; n < b.N; n++ {
				b.StopTimer()
				codexHistoryCache.Forget(path)
				if err := os.WriteFile(path, []byte(prefix), 0600); err != nil {
					b.Fatal(err)
				}
				if incremental {
					if _, err := readCodexImportedExchanges(path, after); err != nil {
						b.Fatal(err)
					}
				}
				f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					b.Fatal(err)
				}
				_, err = f.WriteString(tail)
				f.Close()
				if err != nil {
					b.Fatal(err)
				}
				b.StartTimer()
				items, err := readCodexImportedExchanges(path, after)
				if err != nil || len(items) != 2 {
					b.Fatalf("items=%d err=%v", len(items), err)
				}
			}
		})
	}
}
