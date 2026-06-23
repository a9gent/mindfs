//go:build windows

package commandexec

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

type platformProcess struct {
	cmd       *exec.Cmd
	pi        windows.ProcessInformation
	console   windows.Handle
	attr      *windows.ProcThreadAttributeListContainer
	input     io.WriteCloser
	output    *os.File
	out       chan []byte
	done      chan Result
	exited    chan struct{}
	shell     string
	startedAt time.Time

	closeOnce sync.Once
	exitOnce  sync.Once
}

func startPlatformProcess(ctx context.Context, cmd *exec.Cmd, shell string, terminalCols int) (Process, error) {
	if shouldUseWindowsPipe(shell) {
		return startWindowsPipeProcess(ctx, cmd, shell)
	}
	var inRead, inWrite windows.Handle
	var outRead, outWrite windows.Handle
	if err := windows.CreatePipe(&inRead, &inWrite, nil, 0); err != nil {
		return nil, err
	}
	if err := windows.CreatePipe(&outRead, &outWrite, nil, 0); err != nil {
		_ = windows.CloseHandle(inRead)
		_ = windows.CloseHandle(inWrite)
		return nil, err
	}

	var console windows.Handle
	if err := windows.CreatePseudoConsole(windows.Coord{X: int16(terminalColsOrDefault(terminalCols)), Y: int16(defaultTerminalRows)}, inRead, outWrite, 0, &console); err != nil {
		closeHandles(inRead, inWrite, outRead, outWrite)
		return nil, err
	}
	_ = windows.CloseHandle(inRead)
	_ = windows.CloseHandle(outWrite)

	attr, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		windows.ClosePseudoConsole(console)
		closeHandles(inWrite, outRead)
		return nil, err
	}
	if err := attr.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, unsafe.Pointer(&console), unsafe.Sizeof(console)); err != nil {
		attr.Delete()
		windows.ClosePseudoConsole(console)
		closeHandles(inWrite, outRead)
		return nil, err
	}

	si := windows.StartupInfoEx{
		StartupInfo: windows.StartupInfo{
			Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{})),
		},
		ProcThreadAttributeList: attr.List(),
	}
	var pi windows.ProcessInformation
	appName, err := windows.UTF16PtrFromString(cmd.Path)
	if err != nil {
		attr.Delete()
		windows.ClosePseudoConsole(console)
		closeHandles(inWrite, outRead)
		return nil, err
	}
	commandLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(cmd.Args))
	if err != nil {
		attr.Delete()
		windows.ClosePseudoConsole(console)
		closeHandles(inWrite, outRead)
		return nil, err
	}
	var cwd *uint16
	if strings.TrimSpace(cmd.Dir) != "" {
		cwd, err = windows.UTF16PtrFromString(cmd.Dir)
		if err != nil {
			attr.Delete()
			windows.ClosePseudoConsole(console)
			closeHandles(inWrite, outRead)
			return nil, err
		}
	}
	env, err := windowsEnvBlock(cmd.Env)
	if err != nil {
		attr.Delete()
		windows.ClosePseudoConsole(console)
		closeHandles(inWrite, outRead)
		return nil, err
	}

	startedAt := time.Now().UTC()
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_DEFAULT_ERROR_MODE | windows.CREATE_NO_WINDOW)
	if err := windows.CreateProcess(appName, commandLine, nil, nil, false, flags, env, cwd, &si.StartupInfo, &pi); err != nil {
		attr.Delete()
		windows.ClosePseudoConsole(console)
		closeHandles(inWrite, outRead)
		return nil, err
	}

	p := &platformProcess{
		cmd:       cmd,
		pi:        pi,
		console:   console,
		attr:      attr,
		input:     os.NewFile(uintptr(inWrite), "conpty-input"),
		output:    os.NewFile(uintptr(outRead), "conpty-output"),
		out:       make(chan []byte, 32),
		done:      make(chan Result, 1),
		exited:    make(chan struct{}),
		shell:     shell,
		startedAt: startedAt,
	}
	go p.readLoop()
	go p.waitLoop()
	if ctx != nil {
		go func() {
			select {
			case <-ctx.Done():
				_ = p.KillTree()
			case <-p.exited:
			}
		}()
	}
	return p, nil
}

func shouldUseWindowsPipe(shell string) bool {
	return true
}

func filepathBase(path string) string {
	path = strings.ReplaceAll(path, "\\", "/")
	idx := strings.LastIndex(path, "/")
	if idx >= 0 {
		return path[idx+1:]
	}
	return path
}

func startWindowsPipeProcess(ctx context.Context, cmd *exec.Cmd, shell string) (Process, error) {
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_DEFAULT_ERROR_MODE | windows.CREATE_NO_WINDOW,
	}
	startedAt := time.Now().UTC()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &platformProcess{
		cmd:       cmd,
		out:       make(chan []byte, 32),
		done:      make(chan Result, 1),
		exited:    make(chan struct{}),
		shell:     shell,
		startedAt: startedAt,
	}
	if cmd.Process != nil {
		p.pi.ProcessId = uint32(cmd.Process.Pid)
	}
	var readers sync.WaitGroup
	read := func(name string, r io.Reader) {
		defer readers.Done()
		if shouldDecodeWindowsPipeOutput(shell) {
			r = transform.NewReader(r, simplifiedchinese.GB18030.NewDecoder())
		}
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
	go read("stdout", stdout)
	go read("stderr", stderr)
	go func() {
		readers.Wait()
		close(p.out)
	}()
	go p.waitPipeLoop()
	if ctx != nil {
		go func() {
			select {
			case <-ctx.Done():
				_ = p.KillTree()
			case <-p.exited:
			}
		}()
	}
	return p, nil
}

func startLongShellPlatformProcess(ctx context.Context, cmd *exec.Cmd, shell string, _ int) (Process, error) {
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_DEFAULT_ERROR_MODE | windows.CREATE_NO_WINDOW,
	}
	startedAt := time.Now().UTC()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &platformProcess{
		cmd:       cmd,
		input:     stdin,
		out:       make(chan []byte, 32),
		done:      make(chan Result, 1),
		exited:    make(chan struct{}),
		shell:     shell,
		startedAt: startedAt,
	}
	if cmd.Process != nil {
		p.pi.ProcessId = uint32(cmd.Process.Pid)
	}
	var readers sync.WaitGroup
	read := func(r io.Reader, decode bool) {
		defer readers.Done()
		if decode {
			r = transform.NewReader(r, simplifiedchinese.GB18030.NewDecoder())
		}
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
	go read(stdout, shouldDecodeWindowsLongShellStdout(shell))
	go read(stderr, false)
	go func() {
		readers.Wait()
		close(p.out)
	}()
	go p.waitPipeLoop()
	if ctx != nil {
		go func() {
			select {
			case <-ctx.Done():
				_ = p.KillTree()
			case <-p.exited:
			}
		}()
	}
	return p, nil
}

func shouldDecodeWindowsPipeOutput(shell string) bool {
	base := strings.ToLower(filepathBase(shell))
	return base == "powershell.exe" || base == "powershell"
}

func shouldDecodeWindowsLongShellStdout(shell string) bool {
	base := strings.ToLower(filepathBase(shell))
	return base == "powershell.exe" || base == "powershell"
}

func (p *platformProcess) Output() <-chan []byte {
	return p.out
}

func (p *platformProcess) WriteInput(input []byte) (int, error) {
	if p == nil || p.input == nil {
		return 0, nil
	}
	return p.input.Write(input)
}

func (p *platformProcess) Resize(cols, rows int) error {
	if p == nil || p.console == 0 {
		return nil
	}
	return windows.ResizePseudoConsole(p.console, windows.Coord{X: int16(terminalColsOrDefault(cols)), Y: int16(terminalRowsOrDefault(rows))})
}

func (p *platformProcess) Interrupt() error {
	if p == nil || p.input == nil {
		return nil
	}
	_, err := p.input.Write([]byte{0x03})
	return err
}

func (p *platformProcess) Terminate() error {
	if p == nil || p.pi.Process == 0 {
		return nil
	}
	return windows.TerminateProcess(p.pi.Process, 1)
}

func (p *platformProcess) KillTree() error {
	if p == nil || p.pi.ProcessId == 0 {
		return nil
	}
	kill := exec.Command("taskkill", "/PID", strconv.FormatUint(uint64(p.pi.ProcessId), 10), "/T", "/F")
	if err := kill.Run(); err == nil {
		return nil
	}
	return p.Terminate()
}

func (p *platformProcess) Wait() Result {
	if p == nil {
		return Result{ExitCode: -1}
	}
	return <-p.done
}

func (p *platformProcess) readLoop() {
	defer close(p.out)
	defer func() {
		if p.output != nil {
			_ = p.output.Close()
		}
		if p.console != 0 {
			windows.ClosePseudoConsole(p.console)
		}
	}()
	buf := make([]byte, 16*1024)
	for {
		n, err := p.output.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			p.out <- chunk
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				// ConPTY output closes after the process exits or the pseudo console is closed.
			}
			return
		}
	}
}

func (p *platformProcess) waitLoop() {
	defer p.markExited()
	_, waitErr := windows.WaitForSingleObject(p.pi.Process, windows.INFINITE)
	finishedAt := time.Now().UTC()
	var code uint32
	exitErr := windows.GetExitCodeProcess(p.pi.Process, &code)
	p.closeProcessResources()
	if waitErr != nil {
		exitErr = waitErr
	}
	p.done <- Result{
		Shell:      p.shell,
		ExitCode:   windowsExitCode(code, exitErr),
		Duration:   finishedAt.Sub(p.startedAt),
		StartedAt:  p.startedAt,
		FinishedAt: finishedAt,
		Err:        exitErr,
	}
	close(p.done)
}

func (p *platformProcess) waitPipeLoop() {
	defer p.markExited()
	err := p.cmd.Wait()
	finishedAt := time.Now().UTC()
	exit := pipeExitCode(err)
	p.done <- Result{
		Shell:      p.shell,
		ExitCode:   exit,
		Duration:   finishedAt.Sub(p.startedAt),
		StartedAt:  p.startedAt,
		FinishedAt: finishedAt,
		Err:        err,
	}
	close(p.done)
}

func (p *platformProcess) markExited() {
	p.exitOnce.Do(func() {
		close(p.exited)
	})
}

func (p *platformProcess) closeProcessResources() {
	p.closeOnce.Do(func() {
		if p.input != nil {
			_ = p.input.Close()
		}
		if p.pi.Thread != 0 {
			_ = windows.CloseHandle(p.pi.Thread)
		}
		if p.pi.Process != 0 {
			_ = windows.CloseHandle(p.pi.Process)
		}
		if p.attr != nil {
			p.attr.Delete()
		}
	})
}

func closeHandles(handles ...windows.Handle) {
	for _, h := range handles {
		if h != 0 {
			_ = windows.CloseHandle(h)
		}
	}
}

func windowsEnvBlock(env []string) (*uint16, error) {
	if len(env) == 0 {
		return nil, nil
	}
	for _, entry := range env {
		if strings.ContainsRune(entry, 0) {
			return nil, fmt.Errorf("environment entry contains NUL: %q", entry)
		}
	}
	block := strings.Join(env, "\x00") + "\x00\x00"
	encoded := utf16.Encode([]rune(block))
	if len(encoded) == 0 {
		return nil, nil
	}
	return &encoded[0], nil
}

func windowsExitCode(code uint32, err error) int {
	if err != nil {
		return -1
	}
	return int(code)
}

func pipeExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}
