# Publish a prepared dsh-web-tabs v0.2.1 tree into an existing GitHub repository.
# Requires Git for Windows and authenticated GitHub credentials.
[CmdletBinding()]
param([switch]$SkipTag)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$remote = 'https://github.com/a16689525392-prog/dsh-web-tabs.git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Install Git for Windows first.' }
if (Test-Path '.git') { throw 'Run from the freshly extracted archive (without an existing .git directory).' }

git init -b main
if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
git remote add origin $remote
if ($LASTEXITCODE -ne 0) { throw 'git remote add failed' }
git add --all
if ($LASTEXITCODE -ne 0) { throw 'git add failed' }
git commit -m 'Release dsh-web-tabs v0.2.1 source and distribution artifacts'
if ($LASTEXITCODE -ne 0) { throw 'git commit failed. Configure git user.name and user.email.' }

# The GitHub repository already has README / LICENSE / release notes committed.
# Preserve its history and use the complete reviewed release tree as content.
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'git fetch failed. Check GitHub credentials.' }
git merge --allow-unrelated-histories -s ours origin/main -m 'Merge initial repository publication history'
if ($LASTEXITCODE -ne 0) { throw 'merge failed. No remote changes have been made.' }
git push --set-upstream origin main
if ($LASTEXITCODE -ne 0) { throw 'git push main failed. Check GitHub permissions and remote history.' }

if (-not $SkipTag) {
    git tag -a v0.2.1 -m 'dsh-web-tabs v0.2.1'
    if ($LASTEXITCODE -ne 0) { throw 'git tag failed' }
    git push origin v0.2.1
    if ($LASTEXITCODE -ne 0) { throw 'git push tag failed' }
}
Write-Host 'Push successful. Visit GitHub Actions, then the v0.2.1 Release page.' -ForegroundColor Green
