# MindFS installer for Windows (PowerShell)
# Downloads the correct release from GitHub and installs it.
# Usage:  .\install.ps1 [-Version VERSION] [-Prefix PATH] [-Uninstall] [-Purge]
[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$Prefix  = "$env:LOCALAPPDATA\Programs\mindfs",
    [switch]$Uninstall,
    [switch]$Purge
)

$ErrorActionPreference = "Stop"
$Repo = "a9gent/mindfs"
$ReleaseNotesUrl = "https://raw.githubusercontent.com/$Repo/main/release-notes.md"
$RelayDownloadBase = "https://relay.a9gent.com/mindfs-downloads"

if ($Purge -and -not $Uninstall) {
    Write-Error "-Purge can only be used with -Uninstall."
    exit 1
}

function Add-ToCurrentSessionPath([string]$Dir) {
    if (-not $Dir) { return }
    $segments = @($env:Path -split ';' | Where-Object { $_ -and $_.Trim() -ne "" })
    if ($segments | Where-Object { $_.TrimEnd('\') -ieq $Dir.TrimEnd('\') }) {
        return
    }
    $env:Path = "$Dir;$env:Path"
}

function Remove-FromUserPath([string]$Dir) {
    if (-not $Dir) { return }
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($null -eq $current) { return }
    $target = $Dir.TrimEnd('\')
    $segments = @(
        $current -split ';' |
            Where-Object { $_ -and $_.Trim() -ne "" } |
            Where-Object { $_.TrimEnd('\') -ine $target }
    )
    $next = ($segments -join ';')
    if ($next -ne $current) {
        [Environment]::SetEnvironmentVariable("Path", $next, "User")
        $env:Path = (($env:Path -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $target }) -join ';')
        Broadcast-EnvironmentChange
        Write-Host "  Removed $Dir from your user PATH."
    }
}

function Uninstall-MindFS {
    $BinDir = Join-Path $Prefix "bin"
    $BinPath = Join-Path $BinDir "mindfs.exe"
    $ShareDir = Join-Path $Prefix "share\mindfs"

    Write-Host "Uninstalling mindfs"
    Write-Host "  Prefix: $Prefix"
    Remove-Item -Force $BinPath -ErrorAction SilentlyContinue
    Write-Host "  Removed binary: $BinPath"
    Remove-Item -Recurse -Force $ShareDir -ErrorAction SilentlyContinue
    Write-Host "  Removed shared files: $ShareDir"
    Remove-Item -Force $BinDir -ErrorAction SilentlyContinue
    Remove-Item -Force (Join-Path $Prefix "share") -ErrorAction SilentlyContinue
    Remove-Item -Force $Prefix -ErrorAction SilentlyContinue
    Remove-FromUserPath $BinDir

    if ($Purge) {
        $ConfigDir = Join-Path $env:APPDATA "mindfs"
        Remove-Item -Recurse -Force $ConfigDir -ErrorAction SilentlyContinue
        Write-Host "  Removed user config: $ConfigDir"
        Write-Host "  Project .mindfs directories were not removed."
    } else {
        Write-Host "  User config and project .mindfs data were kept."
        Write-Host "  Re-run with -Uninstall -Purge to remove user-level MindFS config and logs."
    }
    Write-Host "Done."
}

function Broadcast-EnvironmentChange {
    try {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class MindFSEnvBroadcast {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint Msg,
        UIntPtr wParam,
        string lParam,
        uint fuFlags,
        uint uTimeout,
        out UIntPtr lpdwResult);
}
"@ -ErrorAction SilentlyContinue | Out-Null

        $HWND_BROADCAST = [IntPtr]0xffff
        $WM_SETTINGCHANGE = 0x001A
        $SMTO_ABORTIFHUNG = 0x0002
        $result = [UIntPtr]::Zero
        [MindFSEnvBroadcast]::SendMessageTimeout(
            $HWND_BROADCAST,
            $WM_SETTINGCHANGE,
            [UIntPtr]::Zero,
            "Environment",
            $SMTO_ABORTIFHUNG,
            5000,
            [ref]$result
        ) | Out-Null
    } catch {
    }
}

if ($Uninstall) {
    Uninstall-MindFS
    exit 0
}

# ── Detect architecture ────────────────────────────────────────────────────
function Get-Arch {
    $a = $env:PROCESSOR_ARCHITECTURE
    switch -Wildcard ($a) {
        "AMD64" { return "amd64" }
        "ARM64" { return "arm64" }
        "x86" {
            if ($env:PROCESSOR_ARCHITEW6432 -eq "AMD64") { return "amd64" }
            Write-Error "32-bit x86 is not supported."; exit 1
        }
        default { Write-Error "Unsupported architecture: $a"; exit 1 }
    }
}

$OS   = "windows"
$Arch = Get-Arch

function Normalize-Tag([string]$Tag) {
    if (-not $Tag) { return "" }
    return "v" + ($Tag -replace '^v', '')
}

# ── Resolve version from raw metadata if not specified ─────────────────────
if (-not $Version) {
    Write-Host "Fetching latest release version..."
    $metadata = Invoke-WebRequest -Uri $ReleaseNotesUrl -UseBasicParsing
    $firstLine = (($metadata.Content -split "`r?`n") | Select-Object -First 1).Trim()
    if ($firstLine -match '^#\s+MindFS\s+(v?[0-9]+(\.[0-9]+){1,3}[^\s]*)') {
        $Version = $Matches[1]
    }
    if (-not $Version) {
        Write-Error "Could not determine latest version. Use -Version to specify."
        exit 1
    }
}

$Version = Normalize-Tag $Version

Write-Host "Installing mindfs $Version for $OS/$Arch"
Write-Host "  Prefix: $Prefix"

# ── Download ────────────────────────────────────────────────────────────────
$Filename = "mindfs_${Version}_${OS}_${Arch}.zip"
$Url      = "https://github.com/$Repo/releases/download/$Version/$Filename"
$FallbackUrl = "$RelayDownloadBase/$Filename"
$TmpDir   = Join-Path $env:TEMP ("mindfs_install_" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

try {
    $ZipPath = Join-Path $TmpDir $Filename
    Write-Host "  Downloading $Url"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
    } catch {
        Write-Host "  GitHub download failed; trying $FallbackUrl"
        Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue
        Invoke-WebRequest -Uri $FallbackUrl -OutFile $ZipPath -UseBasicParsing
    }

    # ── Extract ─────────────────────────────────────────────────────────────
    Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force
    $PkgDir = Join-Path $TmpDir "mindfs_${Version}_${OS}_${Arch}"

    if (-not (Test-Path $PkgDir -PathType Container)) {
        Write-Error "Unexpected archive structure (expected $PkgDir)."
        exit 1
    }

    $BinSrc = Join-Path $PkgDir "mindfs.exe"
    if (-not (Test-Path $BinSrc -PathType Leaf)) {
        Write-Error "Binary not found in archive: $BinSrc"
        exit 1
    }

    # ── Install binary ──────────────────────────────────────────────────────
    $BinDir = Join-Path $Prefix "bin"
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Copy-Item -Force $BinSrc (Join-Path $BinDir "mindfs.exe")
    Write-Host "  Binary  -> $(Join-Path $BinDir 'mindfs.exe')"

    # ── Install default agent config ───────────────────────────────────────
    $AgentsSrc = Join-Path $PkgDir "agents.json"
    if (Test-Path $AgentsSrc -PathType Leaf) {
        $ShareDir = Join-Path $Prefix "share\mindfs"
        New-Item -ItemType Directory -Force -Path $ShareDir | Out-Null
        Copy-Item -Force $AgentsSrc (Join-Path $ShareDir "agents.json")
        Write-Host "  Agents  -> $(Join-Path $ShareDir 'agents.json')"
    }

    # ── Install web assets (optional) ───────────────────────────────────────
    $WebSrc = Join-Path $PkgDir "web"
    if (Test-Path $WebSrc -PathType Container) {
        $WebDest = Join-Path $Prefix "share\mindfs\web"
        if (Test-Path $WebDest) { Remove-Item -Recurse -Force $WebDest }
        New-Item -ItemType Directory -Force -Path (Split-Path $WebDest) | Out-Null
        Copy-Item -Recurse $WebSrc $WebDest
        Write-Host "  Web     -> $WebDest"
    }

    # ── Add to user PATH (if not already present) ────────────────────────────
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -notlike "*$BinDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$BinDir;$UserPath", "User")
        Add-ToCurrentSessionPath $BinDir
        Broadcast-EnvironmentChange
        Write-Host "  Added $BinDir to your user PATH."
        Write-Host "  Current PowerShell session updated."
        Write-Host "  New terminals should pick up the change automatically."
    } else {
        Add-ToCurrentSessionPath $BinDir
    }

    Write-Host ""
    Write-Host "Done. mindfs installed to $BinDir\mindfs.exe"
} finally {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}
