# dsh-web-tabs one-click installer for Windows PowerShell 5.1+
#
# Does three things:
#   1. locates the DSH data dir + profile
#   2. copies the plugin into <data>/profiles/<profile>/node_modules/dsh-web-tabs/
#   3. idempotently adds this plugin's loader row to <profile>/cordis.patch.yml
#
# Usage (run from inside the plugin folder):
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile other -DataDir D:\mydsh
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
#
# NOTE: keep this file pure ASCII. PowerShell 5.1 parses a BOM-less .ps1 with the
# OEM code page, and non-ASCII bytes there can break parsing on some locales.

[CmdletBinding()]
param(
    [string]$Profile = "desktop",
    [string]$DataDir = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Fail($message) {
    Write-Host ""
    Write-Host "[X] $message" -ForegroundColor Red
    exit 1
}

function Info($message) {
    Write-Host "    $message"
}

function Step($message) {
    Write-Host ""
    Write-Host "==> $message" -ForegroundColor Cyan
}

# Set-Content -Encoding UTF8 on PS 5.1 prepends a BOM. Write BOM-less UTF-8 so we
# never change the file's existing encoding (some YAML readers choke on the BOM).
function WriteTextFile($path, $text) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $utf8)
}

# Keep the line ending the file already uses: DSH ships LF-only YAML, but a file
# re-saved on Windows may be CRLF. Rewriting it with the other convention would
# produce a whole-file diff for no reason.
function NewLineFor($path) {
    if (-not (Test-Path $path)) { return "`n" }
    $raw = [System.IO.File]::ReadAllText($path)
    if ($raw.Contains("`r`n")) { return "`r`n" }
    return "`n"
}

Write-Host ""
Write-Host "dsh-web-tabs installer" -ForegroundColor White

# --- 0. prerequisites ----------------------------------------------------

Step "Checking prerequisites"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) {
    $scriptDir = (Get-Location).Path
}

$pkgJson = Join-Path $scriptDir "package.json"
if (-not (Test-Path $pkgJson)) {
    Fail "package.json not found next to install.ps1. Run this script from inside the dsh-web-tabs folder."
}

$pkg = Get-Content -Raw -Path $pkgJson | ConvertFrom-Json
Info ("plugin: {0} {1}" -f $pkg.name, $pkg.version)

$winPs1 = Join-Path $scriptDir "native\win.ps1"
if (-not (Test-Path $winPs1)) {
    Fail "native\win.ps1 not found. The plugin package looks incomplete."
}

$osVer = [System.Environment]::OSVersion.Version
if ($osVer.Major -lt 10) {
    Fail "This plugin shells out to Win32 SetParent; Windows 10 or newer is required."
}
Info ("windows: {0}" -f $osVer)

# --- 1. locate data dir + profile ---------------------------------------

Step "Locating DSH profile"

if ($DataDir -eq "") {
    if ($env:DSH_DATA_DIR) {
        $DataDir = $env:DSH_DATA_DIR
        Info "data dir from DSH_DATA_DIR"
    } else {
        $DataDir = Join-Path $env:USERPROFILE ".dsh"
        Info "data dir defaults to ~/.dsh"
    }
}

if (-not (Test-Path $DataDir)) {
    Fail "DSH data dir not found: $DataDir  (is DSH NEXT installed and started at least once?)"
}

$profilesRoot = Join-Path $DataDir "profiles"
$profileDir = Join-Path $profilesRoot $Profile

if (-not (Test-Path $profileDir)) {
    $available = @()
    if (Test-Path $profilesRoot) {
        $available = @(Get-ChildItem -Path $profilesRoot -Directory | Select-Object -ExpandProperty Name)
    }
    $hint = ""
    if ($available.Count -gt 0) {
        $hint = "  Available profiles: " + ($available -join ", ")
    }
    Fail ("Profile not found: {0}  {1}  Pass -Profile <name> to pick another one." -f $profileDir, $hint)
}

$nodeModules = Join-Path $profileDir "node_modules"
$target = Join-Path $nodeModules "dsh-web-tabs"
$patchFile = Join-Path $profileDir "cordis.patch.yml"

Info "data dir:  $DataDir"
Info "profile:   $Profile"
Info "target:    $target"
Info "patch:     $patchFile"

if (-not (Test-Path $nodeModules)) {
    if ($DryRun) {
        Info "(dry-run) would create $nodeModules"
    } else {
        New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null
    }
}

# --- 2. copy the files ---------------------------------------------------

Step "Copying plugin files"

$upgrading = $false
if (Test-Path $target) {
    $upgrading = $true
    $installedPkg = Join-Path $target "package.json"
    if (Test-Path $installedPkg) {
        try {
            $old = Get-Content -Raw -Path $installedPkg | ConvertFrom-Json
            Info ("existing install: {0} {1} (upgrading)" -f $old.name, $old.version)
        } catch {
            Info "existing install found (version unknown), overwriting"
        }
    } else {
        Info "existing install found (no package.json), overwriting"
    }
}

if ($DryRun) {
    Info "(dry-run) would copy: lib\, native\win.ps1, package.json, cordis.patch.yml, README.md, ACCEPTANCE.zh.md, screenshot.png"
} else {
    if ($upgrading) {
        Remove-Item -Path $target -Recurse -Force
    }
    New-Item -ItemType Directory -Path $target -Force | Out-Null

    Copy-Item -Path (Join-Path $scriptDir "lib") -Destination $target -Recurse -Force

    $nativeDir = Join-Path $target "native"
    New-Item -ItemType Directory -Path $nativeDir -Force | Out-Null
    Copy-Item -Path $winPs1 -Destination $nativeDir -Force

    foreach ($name in @("package.json", "cordis.patch.yml", "README.md", "ACCEPTANCE.zh.md", "screenshot.png")) {
        $from = Join-Path $scriptDir $name
        if (Test-Path $from) {
            Copy-Item -Path $from -Destination $target -Force
        }
    }

    # drop any editor/agent lock files that may have been copied in
    Get-ChildItem -Path $target -Recurse -Force -Filter ".dsh-ops-update-*.lock" -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue

    Info "files copied"
}

# --- 3. register in cordis.patch.yml (idempotent) -----------------------

Step "Registering plugin in cordis.patch.yml"

$nl = NewLineFor $patchFile
$insertBlock = "- insert:${nl}    - id: dsh-web-tabs${nl}      name: dsh-web-tabs${nl}      config: {}"

if (-not (Test-Path $patchFile)) {
    if ($DryRun) {
        Info "(dry-run) would create $patchFile with the insert block"
    } else {
        WriteTextFile $patchFile ($insertBlock + $nl)
        Info "created cordis.patch.yml"
    }
} else {
    $content = Get-Content -Raw -Path $patchFile
    $already = $content -match '(?m)^\s*-\s*id:\s*dsh-web-tabs\s*$'

    if ($already) {
        Info "already registered, leaving cordis.patch.yml untouched"
    } elseif ($DryRun) {
        Info "(dry-run) would append the insert block to $patchFile"
    } else {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backup = $patchFile + ".bak-" + $stamp
        Copy-Item -Path $patchFile -Destination $backup -Force
        Info "backup: $backup"

        $trimmed = $content.TrimEnd()
        $updated = $trimmed + $nl + $nl + $insertBlock + $nl
        WriteTextFile $patchFile $updated
        Info "appended the insert block"
    }
}

# --- 4. done -------------------------------------------------------------

Step "Done"

if ($DryRun) {
    Write-Host ""
    Write-Host "Dry run only - nothing was written." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "  Installed to: $target" -ForegroundColor Green
Write-Host ""
Write-Host "  NEXT STEP: fully quit DSH NEXT and start it again." -ForegroundColor Yellow
Write-Host "  Ctrl+R only reloads the renderer - the host half of the plugin" -ForegroundColor Yellow
Write-Host "  (lib\index.js / lib\embed.js / native\win.ps1) will NOT be loaded." -ForegroundColor Yellow
Write-Host ""
Write-Host "  After restart, open the 'web' tab in DSH and click the plus button." -ForegroundColor White
Write-Host ""
