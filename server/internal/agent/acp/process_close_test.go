package acp

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"testing"
)

type retryProcessTree struct {
	killErr, closeErr error
	kills, closes     int
}

func (t *retryProcessTree) Kill() error {
	t.kills++
	err := t.killErr
	t.killErr = nil
	return err
}

func (t *retryProcessTree) Close() error {
	t.closes++
	err := t.closeErr
	t.closeErr = nil
	return err
}

func processForCloseTest(tree processTree) *Process {
	waitCh := make(chan error, 1)
	waitCh <- &exec.ExitError{}
	close(waitCh)
	return &Process{cmd: &exec.Cmd{Process: &os.Process{Pid: 123}}, tree: tree, waitCh: waitCh}
}

func TestProcessCloseCanRetryCleanupFailure(t *testing.T) {
	wantErr := errors.New("cleanup failed")
	for _, phase := range []string{"kill", "close"} {
		t.Run(phase, func(t *testing.T) {
			tree := &retryProcessTree{}
			if phase == "kill" {
				tree.killErr = wantErr
			} else {
				tree.closeErr = wantErr
			}
			p := processForCloseTest(tree)
			if err := p.Close(); !errors.Is(err, wantErr) {
				t.Fatalf("first Close = %v, want %v", err, wantErr)
			}
			if p.ProcessID() != 123 {
				t.Fatal("failed cleanup discarded the process")
			}
			if err := p.Close(); err != nil {
				t.Fatalf("retry Close: %v", err)
			}
			if p.ProcessID() != 0 || tree.kills != 2 {
				t.Fatalf("retry did not finish cleanup: pid=%d kills=%d", p.ProcessID(), tree.kills)
			}
		})
	}
}

func TestProcessConcurrentClose(t *testing.T) {
	tree := &retryProcessTree{}
	p := processForCloseTest(tree)
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := p.Close(); err != nil {
				t.Errorf("Close: %v", err)
			}
		}()
	}
	wg.Wait()
	if tree.kills != 1 || tree.closes != 1 {
		t.Fatalf("cleanup calls: kills=%d closes=%d", tree.kills, tree.closes)
	}
}
