# dsh-web-tabs uninstaller for Windows PowerShell 5.1+
#
# Does two things:
#   1. removes <profile>/node_modules/dsh-web-tabs/
#   2. removes this plugin's "insert" block from <profile>/cordis.patch.yml
#
# Usage (run from anywhere):
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Profile other
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepData
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -DryRun
#
# NOTE: keep this file pure ASCII. PowerShell 5.1 parses a BOM-less .ps1 with the
# OEM code page, and GBK trail bytes can collide with ASCII punctuation.

[CmdletBinding()]
param(
    [string]$Profile = "desktop",
    [string]$DataDir = "",
    [switch]$KeepData,
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

# Set-Content -Encoding UTF8 on PS 5.1 prepends a BOM. Write BOM-less UTF-8 so the
# file keeps the encoding it already had (original cordis.patch.yml has no BOM).
function WriteTextFile($path, $text) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $utf8)
}

function NewLineFor($path) {
    if (-not (Test-Path $path)) { return "`n" }
    $raw = [System.IO.File]::ReadAllText($path)
    if ($raw.Contains("`r`n")) { return "`r`n" }
    return "`n"
}

Write-Host ""
Write-Host "dsh-web-tabs uninstaller" -ForegroundColor White

# --- 1. locate -----------------------------------------------------------

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
    Fail "DSH data dir not found: $DataDir"
}

$profileDir = Join-Path (Join-Path $DataDir "profiles") $Profile
if (-not (Test-Path $profileDir)) {
    Fail "Profile not found: $profileDir`n    Pass -Profile <name> to pick another one."
}

$target = Join-Path (Join-Path $profileDir "node_modules") "dsh-web-tabs"
$patchFile = Join-Path $profileDir "cordis.patch.yml"

Info "target:  $target"
Info "patch:   $patchFile"

# --- 2. remove the package folder ---------------------------------------

Step "Removing plugin files"

if (-not (Test-Path $target)) {
    Info "not installed, nothing to remove"
} elseif ($DryRun) {
    Info "(dry-run) would delete $target"
} else {
    Remove-Item -Path $target -Recurse -Force
    Info "deleted $target"
}

# --- 3. strip the insert block from cordis.patch.yml ---------------------

Step "Unregistering from cordis.patch.yml"

if (-not (Test-Path $patchFile)) {
    Info "cordis.patch.yml not found, nothing to unregister"
} else {
    $lines = @(Get-Content -Path $patchFile)
    $kept = New-Object System.Collections.Generic.List[string]
    $removed = 0
    $index = 0

    while ($index -lt $lines.Count) {
        $line = $lines[$index]

        $startsInsert = $line -match '^\s*-\s*insert:\s*$'
        if (-not $startsInsert) {
            $kept.Add($line)
            $index = $index + 1
            continue
        }

        # Collect the indented rows that belong to this "- insert:" entry.
        $blockEnd = $index + 1
        $hit = $false
        while ($blockEnd -lt $lines.Count) {
            $row = $lines[$blockEnd]
            if ($row -match '^\s+-\s*id:\s*dsh-web-tabs\s*$') {
                $hit = $true
            }
            $isDedented = ($row -match '^\s*-') -and ($row -notmatch '^\s{2,}')
            if ($isDedented) { break }
            $blockEnd = $blockEnd + 1
        }

        if ($hit) {
            $removed = $removed + 1
            $index = $blockEnd
        } else {
            $kept.Add($line)
            $index = $index + 1
        }
    }

    if ($removed -eq 0) {
        Info "no dsh-web-tabs insert block found, leaving file untouched"
    } elseif ($DryRun) {
        Info "(dry-run) would remove $removed insert block(s)"
    } else {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backup = $patchFile + ".bak-" + $stamp
        Copy-Item -Path $patchFile -Destination $backup -Force
        Info "backup: $backup"
        $nl = NewLineFor $patchFile
        $text = [string]::Join($nl, $kept.ToArray()).TrimEnd() + $nl
        WriteTextFile $patchFile $text
        Info "removed $removed insert block(s)"
    }
}

# --- 4. plugin data ------------------------------------------------------

Step "Plugin data"

$dataPath = Join-Path $DataDir "web-tabs"

if (-not (Test-Path $dataPath)) {
    Info "no plugin data at $dataPath"
} elseif ($KeepData) {
    Info "keeping $dataPath because -KeepData was passed"
} elseif ($DryRun) {
    Info "(dry-run) would delete $dataPath"
} else {
    Info "deleting $dataPath (pass -KeepData to keep it)"
    Remove-Item -Path $dataPath -Recurse -Force
}

# --- 5. done -------------------------------------------------------------

Step "Done"

if ($DryRun) {
    Write-Host ""
    Write-Host "Dry run only - nothing was changed." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "  Uninstalled." -ForegroundColor Green
Write-Host ""
Write-Host "  Fully quit DSH NEXT and start it again for the change to take effect." -ForegroundColor Yellow
Write-Host ""
