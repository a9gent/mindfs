//go:build windows

package acp

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsProcessTree struct {
	mu  sync.Mutex
	job windows.Handle
}

func startProcessCommand(cmd *exec.Cmd) (processTree, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("create ACP job: %w", err)
	}
	tree := &windowsProcessTree{job: job}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, errors.Join(fmt.Errorf("configure ACP job: %w", err), windows.CloseHandle(job))
	}

	// Keep cancellation from closing the job while the suspended process is
	// being assigned. No agent code can run before assignment succeeds.
	tree.mu.Lock()
	cmd.Cancel = tree.Kill
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_SUSPENDED
	err = cmd.Start()
	if err == nil {
		err = assignAndResumeProcess(job, cmd.Process.Pid)
	}
	tree.mu.Unlock()
	if err != nil {
		var killErr, waitErr error
		if cmd.Process != nil {
			killErr = cmd.Process.Kill()
			if errors.Is(killErr, os.ErrProcessDone) {
				killErr = nil
			}
		}
		// Start will return no owner for the job: release it unconditionally,
		// including when assignment failed while the child was suspended.
		tree.mu.Lock()
		closeErr := windows.CloseHandle(job)
		if closeErr == nil {
			tree.job = 0
		}
		tree.mu.Unlock()
		if cmd.Process != nil {
			waitErr = cmd.Wait()
		}
		return nil, errors.Join(err, killErr, closeErr, waitErr)
	}
	return tree, nil
}

func assignAndResumeProcess(job windows.Handle, pid int) error {
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("open suspended ACP process: %w", err)
	}
	defer windows.CloseHandle(process)
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		return fmt.Errorf("assign ACP process to job: %w", err)
	}

	// os/exec closes the primary thread handle. Recover it from a snapshot
	// while the process is still suspended, before it can create other threads.
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return fmt.Errorf("snapshot ACP threads: %w", err)
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	for err = windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != uint32(pid) {
			continue
		}
		thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if err != nil {
			return fmt.Errorf("open suspended ACP thread: %w", err)
		}
		defer windows.CloseHandle(thread)
		if _, err := windows.ResumeThread(thread); err != nil {
			return fmt.Errorf("resume ACP thread: %w", err)
		}
		return nil
	}
	return fmt.Errorf("find suspended ACP thread for pid %d: %w", pid, err)
}

func (t *windowsProcessTree) Kill() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job == 0 {
		return os.ErrProcessDone
	}
	return windows.TerminateJobObject(t.job, 1)
}

func (t *windowsProcessTree) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job == 0 {
		return nil
	}
	if err := windows.TerminateJobObject(t.job, 1); err != nil {
		return fmt.Errorf("terminate ACP job: %w", err)
	}
	// Waiting only for cmd.exe does not guarantee descendants have released
	// their session locks. Keep the job until all its processes have exited.
	deadline := time.Now().Add(5 * time.Second)
	for {
		active, err := activeJobProcesses(t.job)
		if err != nil {
			return fmt.Errorf("query ACP job: %w", err)
		}
		if active == 0 {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("ACP job did not exit after kill: active_processes=%d", active)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The job handle is not inheritable. Closing its last handle also kills
	// descendants after the wrapper has already exited or MindFS shuts down.
	if err := windows.CloseHandle(t.job); err != nil {
		return err
	}
	t.job = 0
	return nil
}

func activeJobProcesses(job windows.Handle) (uint32, error) {
	// JOBOBJECT_BASIC_ACCOUNTING_INFORMATION is not exposed by x/sys/windows.
	var info struct {
		TotalUserTime             int64
		TotalKernelTime           int64
		ThisPeriodTotalUserTime   int64
		ThisPeriodTotalKernelTime int64
		TotalPageFaultCount       uint32
		TotalProcesses            uint32
		ActiveProcesses           uint32
		TotalTerminatedProcesses  uint32
	}
	err := windows.QueryInformationJobObject(job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil)
	return info.ActiveProcesses, err
}

func configurePlatformProcessCommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windowsACPProcessCreationFlags(),
	}
}

func platformProcessDiagnostic(pid int) string {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return fmt.Sprintf("process_handle_error=%q", err)
	}
	defer windows.CloseHandle(process)
	state, err := windows.WaitForSingleObject(process, 0)
	if err != nil {
		return fmt.Sprintf("process_wait_error=%q", err)
	}
	var exitCode uint32
	if err := windows.GetExitCodeProcess(process, &exitCode); err != nil {
		return fmt.Sprintf("process_exit_code_error=%q", err)
	}
	return fmt.Sprintf("process_exited=%t exit_code=%d", state == windows.WAIT_OBJECT_0, exitCode)
}
