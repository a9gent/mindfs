//go:build windows

package update

import (
	"io"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func startReplacementProcess(currentPID int, exe string, args []string, stdout, stderr io.Writer, pkgDir, prefix string) error {
	argList := append([]string(nil), args...)
	quotedArgs := make([]string, 0, len(argList))
	for _, arg := range argList {
		quotedArgs = append(quotedArgs, psQuote(arg))
	}

	script := strings.Join([]string{
		"$pidToWait = " + strconv.Itoa(currentPID),
		"$exe = " + psQuote(exe),
		"$pkgDir = " + psQuote(pkgDir),
		"$prefix = " + psQuote(prefix),
		"$argList = @(" + strings.Join(quotedArgs, ", ") + ")",
		"for ($i = 0; $i -lt 100; $i++) {",
		"  if (-not (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue)) { break }",
		"  Start-Sleep -Milliseconds 200",
		"}",
		"$shareDir = Join-Path $prefix 'share\\mindfs'",
		"$binDir = Join-Path $prefix 'bin'",
		"New-Item -ItemType Directory -Force -Path $binDir | Out-Null",
		"New-Item -ItemType Directory -Force -Path $shareDir | Out-Null",
		"$srcBin = Join-Path $pkgDir 'mindfs.exe'",
		"$dstBin = Join-Path $binDir 'mindfs.exe'",
		"Copy-Item -Force $srcBin $dstBin",
		"$srcAgents = Join-Path $pkgDir 'agents.json'",
		"if (Test-Path $srcAgents -PathType Leaf) { Copy-Item -Force $srcAgents (Join-Path $shareDir 'agents.json') }",
		"$srcWeb = Join-Path $pkgDir 'web'",
		"$dstWeb = Join-Path $shareDir 'web'",
		"if (Test-Path $srcWeb -PathType Container) {",
		"  if (Test-Path $dstWeb) { Remove-Item -Recurse -Force $dstWeb }",
		"  Copy-Item -Recurse $srcWeb $dstWeb",
		"}",
		"$env:MINDFS_INTERNAL_RESTART = '1'",
		"Start-Process -FilePath $exe -ArgumentList $argList -WindowStyle Hidden",
	}, "; ")

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
	return cmd.Start()
}

func psQuote(v string) string {
	return "'" + strings.ReplaceAll(v, "'", "''") + "'"
}
