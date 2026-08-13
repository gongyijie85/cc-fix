param([switch]$LegacyNpmCli)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $repoRoot 'package.json'
$packageVersion = if (Test-Path -LiteralPath $packageJsonPath) {
    (Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json).version
} else { 'current npm version' }

Write-Host 'CC-Fix Windows now ships as a self-contained installer.' -ForegroundColor Yellow
Write-Host 'Download CC-Fix-Setup-<version>-x64.exe and verify its SHA-256 before running it.' -ForegroundColor Yellow
Write-Host 'This script is retained only for the legacy npm CLI channel; it does not install the desktop product.' -ForegroundColor Yellow

if (-not $LegacyNpmCli) {
    Write-Host 'To explicitly install only the legacy npm CLI, rerun with -LegacyNpmCli.' -ForegroundColor Cyan
    exit 78
}

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'The legacy npm CLI requires Node.js and npm. The recommended Windows installer includes its own runtime.'
}

Write-Host "Installing legacy npm CLI channel ($packageVersion)..." -ForegroundColor Cyan
& npm install -g cc-fix
if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
& cc-fix --version
if ($LASTEXITCODE -ne 0) { throw "cc-fix verification failed with exit code $LASTEXITCODE" }
Write-Host 'Legacy CLI installed. Use the Windows installer for the desktop app and managed lifecycle.' -ForegroundColor Green
