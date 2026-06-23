//go:build !windows

package commandexec

import (
	"context"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

type platformProcess struct {
	cmd       *exec.Cmd
	pty       *os.File
	out       chan []byte
	done      chan Result
	shell     string
	startedAt time.Time
}

func startPlatformProcess(_ context.Context, cmd *exec.Cmd, shell string, terminalCols int) (Process, error) {
	startedAt := time.Now().UTC()
	cmd.SysProcAttr = nil
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: defaultTerminalRows, Cols: terminalColsOrDefault(terminalCols)})
	if err != nil {
		log.Printf("[commandexec] pty.start.error shell=%q err=%v fallback=pipe", shell, err)
		fallback := exec.Command(cmd.Path, pipeFallbackArgs(shell, cmd.Args[1:])...)
		fallback.Dir = cmd.Dir
		fallback.Env = cmd.Env
		fallback.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		return startPipeFallback(fallback, shell, startedAt)
	}
	p := &platformProcess{
		cmd:       cmd,
		pty:       f,
		out:       make(chan []byte, 32),
		done:      make(chan Result, 1),
		shell:     shell,
		startedAt: startedAt,
	}
	go p.readLoop()
	go p.waitLoop()
	return p, nil
}

func startLongShellPlatformProcess(ctx context.Context, cmd *exec.Cmd, shell string, terminalCols int) (Process, error) {
	return startPlatformProcess(ctx, cmd, shell, terminalCols)
}

func pipeFallbackArgs(shell string, args []string) []string {
	out := append([]string(nil), args...)
	base := filepath.Base(shell)
	switch base {
	case "bash", "zsh":
		for i, arg := range out {
			if arg == "-ic" {
				out[i] = "-lc"
				return out
			}
		}
	case "fish":
		if len(out) >= 2 && out[0] == "-i" && out[1] == "-c" {
			return out[1:]
		}
	}
	return out
}

func startPipeFallback(cmd *exec.Cmd, shell string, startedAt time.Time) (Process, error) {
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &platformProcess{
		cmd:       cmd,
		out:       make(chan []byte, 32),
		done:      make(chan Result, 1),
		shell:     shell,
		startedAt: startedAt,
	}
	var readers sync.WaitGroup
	read := func(r io.Reader) {
		defer readers.Done()
		buf := make([]byte, 16*1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				chunk := append([]byte(nil), buf[:n]...)
				p.out <- chunk
			}
			if err != nil {
				return
			}
		}
	}
	readers.Add(2)
	go read(stdout)
	go read(stderr)
	go func() {
		readers.Wait()
		close(p.out)
	}()
	go p.waitLoop()
	return p, nil
}

func (p *platformProcess) Output() <-chan []byte {
	return p.out
}

func (p *platformProcess) WriteInput(input []byte) (int, error) {
	if p == nil || p.pty == nil {
		return 0, nil
	}
	return p.pty.Write(input)
}

func (p *platformProcess) Resize(cols, rows int) error {
	if p == nil || p.pty == nil {
		return nil
	}
	return pty.Setsize(p.pty, &pty.Winsize{Rows: terminalRowsOrDefault(rows), Cols: terminalColsOrDefault(cols)})
}

func (p *platformProcess) Interrupt() error {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return nil
	}
	return syscall.Kill(-p.cmd.Process.Pid, syscall.SIGINT)
}

func (p *platformProcess) Terminate() error {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return nil
	}
	return syscall.Kill(-p.cmd.Process.Pid, syscall.SIGTERM)
}

func (p *platformProcess) KillTree() error {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return nil
	}
	return syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
}

func (p *platformProcess) Wait() Result {
	if p == nil {
		return Result{ExitCode: -1}
	}
	return <-p.done
}

func (p *platformProcess) readLoop() {
	defer close(p.out)
	buf := make([]byte, 16*1024)
	for {
		n, err := p.pty.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			p.out <- chunk
		}
		if err != nil {
			if err != io.EOF {
				// PTY read commonly returns an input/output error after process exit.
			}
			return
		}
	}
}

func (p *platformProcess) waitLoop() {
	err := p.cmd.Wait()
	finishedAt := time.Now().UTC()
	if p.pty != nil {
		_ = p.pty.Close()
	}
	p.done <- Result{
		Shell:      p.shell,
		ExitCode:   exitCode(err),
		Duration:   finishedAt.Sub(p.startedAt),
		StartedAt:  p.startedAt,
		FinishedAt: finishedAt,
		Err:        err,
	}
	close(p.done)
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode()
	}
	return -1
}
