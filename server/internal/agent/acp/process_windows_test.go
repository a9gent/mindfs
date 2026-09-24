//go:build windows

package acp

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// The shell and wrapper deliberately leave stdout/stderr inherited by the leaf,
// just like npm shims. The leaf also holds an exclusive file handle to model an
// agent's session lock, without requiring node or an installed ACP agent.
func TestWindowsACPHelper(t *testing.T) {
	mode := ""
	for i, arg := range os.Args {
		if arg == "--" && i+1 < len(os.Args) {
			mode = os.Args[i+1]
			break
		}
	}
	if mode == "" {
		return
	}
	switch mode {
	case "wrapper":
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		child := exec.Command(exe, "-test.run=^TestWindowsACPHelper$", "--", "leaf")
		child.Stdout = os.Stdout
		child.Stderr = os.Stderr
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		for {
			if _, err := os.Stat(os.Getenv("MINDFS_ACP_TEST_EXIT")); err == nil {
				os.Exit(0)
			}
			time.Sleep(10 * time.Millisecond)
		}
	case "leaf":
		path, err := windows.UTF16PtrFromString(os.Getenv("MINDFS_ACP_TEST_LOCK"))
		if err != nil {
			t.Fatal(err)
		}
		handle, err := windows.CreateFile(path, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.CREATE_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer windows.CloseHandle(handle)
		if err := os.WriteFile(os.Getenv("MINDFS_ACP_TEST_READY"), []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
			t.Fatal(err)
		}
		for {
			time.Sleep(time.Hour)
		}
	default:
		t.Fatalf("unknown helper mode %q", mode)
	}
}

func TestWindowsACPProcessTreeCleanup(t *testing.T) {
	for _, action := range []string{"close", "cancel", "wrapper-exit"} {
		// Repeated starts model refreshing the external-session panel.
		for iteration := range 3 {
			t.Run(fmt.Sprintf("%s/%d", action, iteration), func(t *testing.T) {
				dir := filepath.Join(t.TempDir(), "agent files")
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
				exe, err := os.Executable()
				if err != nil {
					t.Fatal(err)
				}
				ready := filepath.Join(dir, "ready")
				exit := filepath.Join(dir, "exit")
				lock := filepath.Join(dir, "session.lock")
				script := "@\"%MINDFS_ACP_TEST_EXE%\" -test.run=TestWindowsACPHelper -- wrapper\r\n"
				if err := os.WriteFile(filepath.Join(dir, "acp-helper.cmd"), []byte(script), 0600); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				p, err := Start(ctx, "test", "cmd.exe", []string{"/d", "/c", "acp-helper.cmd"}, dir, map[string]string{
					"MINDFS_ACP_TEST_EXE":   exe,
					"MINDFS_ACP_TEST_READY": ready,
					"MINDFS_ACP_TEST_EXIT":  exit,
					"MINDFS_ACP_TEST_LOCK":  lock,
				})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = p.Close() })
				pid := waitWindowsHelperReady(t, ready)
				leaf, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(pid))
				if err != nil {
					t.Fatalf("leaf did not stay alive: %v", err)
				}
				defer windows.CloseHandle(leaf)
				defer windows.TerminateProcess(leaf, 1) // also clean up if the assertion fails
				if file, err := os.OpenFile(lock, os.O_RDWR, 0); err == nil {
					file.Close()
					t.Fatal("leaf did not acquire the session lock")
				}
				switch action {
				case "close":
					if err := p.Close(); err != nil {
						t.Fatal(err)
					}
				case "cancel":
					cancel()
				case "wrapper-exit":
					if err := os.WriteFile(exit, nil, 0600); err != nil {
						t.Fatal(err)
					}
				}
				// Close promises the lock is released on return; cancellation and
				// natural wrapper exit must work without an explicit Close call.
				timeout := uint32(10000)
				if action == "close" {
					timeout = 0
				}
				if state, err := windows.WaitForSingleObject(leaf, timeout); err != nil || state != windows.WAIT_OBJECT_0 {
					t.Fatalf("leaf survived %s: wait=%d err=%v", action, state, err)
				}
				file, err := os.OpenFile(lock, os.O_RDWR, 0)
				if err != nil {
					t.Fatalf("session lock was not released: %v", err)
				}
				file.Close()
				if err := p.Close(); err != nil {
					t.Fatalf("final Close: %v", err)
				}
			})
		}
	}
}

func waitWindowsHelperReady(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if contents, err := os.ReadFile(path); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(contents))); err == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("ACP helper did not become ready")
	return 0
}

func TestWindowsACPStartFailure(t *testing.T) {
	if p, err := Start(context.Background(), "test", filepath.Join(t.TempDir(), "missing.exe"), nil, "", nil); err == nil || p != nil {
		t.Fatalf("missing command: process=%v err=%v", p, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if p, err := Start(ctx, "test", "cmd.exe", []string{"/c", "exit"}, "", nil); err == nil || p != nil {
		t.Fatalf("canceled start: process=%v err=%v", p, err)
	}
}
