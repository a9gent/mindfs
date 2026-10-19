package historycache

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestReadOnlyAppendedCompleteRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	write := func(data string, appendFile bool) {
		t.Helper()
		flags := os.O_CREATE | os.O_WRONLY | os.O_TRUNC
		if appendFile {
			flags = os.O_WRONLY | os.O_APPEND
		}
		f, err := os.OpenFile(path, flags, 0600)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.WriteString(data); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
	}
	feeds := 0
	create := func() Parser[[]int] {
		var items []int
		return Parser[[]int]{Feed: func(line string) error {
			feeds++
			var n int
			if err := json.Unmarshal([]byte(line), &n); err != nil {
				return err
			}
			items = append(items, n)
			return nil
		}, Snapshot: func() []int { return items }}
	}
	var cache Cache[[]int]
	read := func(want []int, calls int) {
		t.Helper()
		got, err := cache.Read(path, create, nil)
		if err != nil || !reflect.DeepEqual(got, want) || feeds != calls {
			t.Fatalf("got %v, feeds %d, err %v; want %v, feeds %d", got, feeds, err, want, calls)
		}
		if len(got) > 0 {
			got[0] = 999
		} // caller mutations must not poison state
	}
	write("1\n2\n", false)
	read([]int{1, 2}, 2)
	read([]int{1, 2}, 2)
	write("3\n", true)
	read([]int{1, 2, 3}, 3)
	write("-", true)
	read([]int{1, 2, 3}, 3)
	write("4\n", true)
	read([]int{1, 2, 3, -4}, 4)
	write("5\n", false)
	read([]int{5}, 5) // truncate
	write("6\n", false)
	stamp := time.Now().Add(time.Hour)
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	read([]int{6}, 6) // same-size rewrite
	if err := os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	write("7\n8\n", false)
	read([]int{7, 8}, 8) // replacement inode
	write("9\n10\n11\n", false)
	read([]int{9, 10, 11}, 11) // in-place rewrite with growth
}

func TestConcurrentReadersShareOneParser(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	if err := os.WriteFile(path, []byte("1\n2\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var cache Cache[[]string]
	feeds := 0
	create := func() Parser[[]string] {
		var items []string
		return Parser[[]string]{Feed: func(line string) error { feeds++; items = append(items, line); return nil }, Snapshot: func() []string { return items }}
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := cache.Read(path, create, nil)
			if err != nil || len(got) != 2 {
				t.Errorf("read: %v %v", got, err)
				return
			}
			got[0] = "local"
		}()
	}
	wg.Wait()
	if feeds != 2 {
		t.Fatalf("parsed %d lines, want 2", feeds)
	}
}

func TestFailedParserIsRebuilt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	if err := os.WriteFile(path, []byte("1\n2\n"), 0600); err != nil {
		t.Fatal(err)
	}
	fail := true
	var cache Cache[[]string]
	create := func() Parser[[]string] {
		var items []string
		return Parser[[]string]{Feed: func(line string) error {
			items = append(items, line)
			if fail && len(items) == 2 {
				return errors.New("injected failure")
			}
			return nil
		}, Snapshot: func() []string { return items }}
	}
	if _, err := cache.Read(path, create, nil); err == nil {
		t.Fatal("expected failure")
	}
	fail = false
	got, err := cache.Read(path, create, nil)
	if err != nil || len(got) != 2 {
		t.Fatalf("retry: %v %v", got, err)
	}
}
