//go:build windows

package update

import (
	"io"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func startReplacementProcess(currentPID int, exe string, args []string, stdout, stderr io.Writer, pkgDir, dstBin, dstAgents, dstWeb string) error {
	argList := append([]string(nil), args...)
	quotedArgs := make([]string, 0, len(argList))
	for _, arg := range argList {
		quotedArgs = append(quotedArgs, psQuote(arg))
	}

	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"$pidToWait = " + strconv.Itoa(currentPID),
		"$exe = " + psQuote(exe),
		"$pkgDir = " + psQuote(pkgDir),
		"$cleanupDir = Split-Path -Parent (Split-Path -Parent $pkgDir)",
		"$dstBin = " + psQuote(dstBin),
		"$dstAgents = " + psQuote(dstAgents),
		"$dstWeb = " + psQuote(dstWeb),
		"$argList = @(" + strings.Join(quotedArgs, ", ") + ")",
		"for ($i = 0; $i -lt 100; $i++) {",
		"  if (-not (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue)) { break }",
		"  Start-Sleep -Milliseconds 200",
		"}",
		"$srcBin = Join-Path $pkgDir 'mindfs.exe'",
		"New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dstBin) | Out-Null",
		"Copy-Item -Force $srcBin $dstBin",
		"$srcAgents = Join-Path $pkgDir 'agents.json'",
		"if (Test-Path $srcAgents -PathType Leaf) {",
		"  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dstAgents) | Out-Null",
		"  Copy-Item -Force $srcAgents $dstAgents",
		"}",
		"$srcWeb = Join-Path $pkgDir 'web'",
		"if (Test-Path $srcWeb -PathType Container) {",
		"  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dstWeb) | Out-Null",
		"  if (Test-Path $dstWeb) { Remove-Item -Recurse -Force $dstWeb }",
		"  Copy-Item -Recurse $srcWeb $dstWeb",
		"}",
		"$env:MINDFS_INTERNAL_RESTART = '1'",
		"Start-Process -FilePath $exe -ArgumentList $argList -WindowStyle Hidden",
		"if ($cleanupDir -and (Test-Path $cleanupDir)) { Remove-Item -Recurse -Force $cleanupDir -ErrorAction SilentlyContinue }",
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
