//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func installPlatformAutoStart(exe string, args []string, _ string) (string, error) {
	powershellArgs := make([]string, 0, len(args))
	for _, arg := range args {
		powershellArgs = append(powershellArgs, "'"+strings.ReplaceAll(arg, "'", "''")+"'")
	}
	script := "& '" + strings.ReplaceAll(exe, "'", "''") + "' " + strings.Join(powershellArgs, " ")
	command := windowsCommandLine([]string{"powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script})
	reg := exec.Command("reg.exe", "add", `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "/v", "MindFS", "/t", "REG_SZ", "/d", command, "/f")
	reg.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if output, err := reg.CombinedOutput(); err != nil {
		return "", fmt.Errorf("register Windows startup item: %s", strings.TrimSpace(string(output)))
	}
	return `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\MindFS`, nil
}

func detectedPlatformShell() string {
	if shell := windowsParentShell(); shell != "" {
		return shell
	}
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell
	}
	if shell := strings.TrimSpace(os.Getenv("COMSPEC")); shell != "" {
		return shell
	}
	return "cmd.exe"
}

func windowsParentShell() string {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	if err := windows.Process32First(snapshot, &entry); err != nil {
		return ""
	}
	parentPID := uint32(os.Getppid())
	for {
		if entry.ProcessID == parentPID {
			name := windows.UTF16ToString(entry.ExeFile[:])
			switch strings.ToLower(filepath.Base(name)) {
			case "powershell.exe", "pwsh.exe", "cmd.exe", "bash.exe", "zsh.exe", "fish.exe":
				if path, lookupErr := exec.LookPath(name); lookupErr == nil {
					return path
				}
				return name
			}
			return ""
		}
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			return ""
		}
	}
}

func removePlatformAutoStart() error {
	reg := exec.Command("reg.exe", "delete", `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "/v", "MindFS", "/f")
	reg.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := reg.CombinedOutput()
	if err != nil {
		text := strings.ToLower(string(output))
		if strings.Contains(text, "unable to find") || strings.Contains(text, "cannot find") {
			return nil
		}
		return fmt.Errorf("remove Windows startup item: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

func windowsCommandLine(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, arg := range args {
		quoted = append(quoted, syscall.EscapeArg(arg))
	}
	return strings.Join(quoted, " ")
}
