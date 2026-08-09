param([switch]$SkipRustBuild)

$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $prototypeRoot '..\..')
$nodeVersion = '24.18.1'
$nodeArchive = "node-v$nodeVersion-win-x64.zip"
$cacheDir = Join-Path $prototypeRoot '.cache'
$archivePath = Join-Path $cacheDir $nodeArchive
$checksumsPath = Join-Path $cacheDir 'SHASUMS256.txt'
$runtimeSource = Join-Path $cacheDir "node-v$nodeVersion-win-x64\node.exe"
$buildDir = Join-Path $prototypeRoot 'build'
$outputDir = Join-Path $buildDir 'portable'
$iconDir = Join-Path $prototypeRoot 'src-tauri\icons'
$iconPath = Join-Path $iconDir 'icon.ico'

New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

if (-not (Test-Path -LiteralPath $iconPath)) {
  Add-Type -AssemblyName System.Drawing
  New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
  $bitmap = New-Object System.Drawing.Bitmap 32, 32
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::FromArgb(37, 99, 235))
    $font = New-Object System.Drawing.Font 'Segoe UI', 18, ([System.Drawing.FontStyle]::Bold)
    try { $graphics.DrawString('C', $font, [System.Drawing.Brushes]::White, 5, 3) } finally { $font.Dispose() }
    $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
    $stream = [System.IO.File]::Create($iconPath)
    try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose() }
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}

if (-not (Test-Path -LiteralPath $runtimeSource)) {
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/$nodeArchive" -OutFile $archivePath
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -OutFile $checksumsPath
  $checksums = Get-Content -Raw -LiteralPath $checksumsPath
  $expectedLine = ($checksums -split "`n" | Where-Object { $_ -match [regex]::Escape($nodeArchive) } | Select-Object -First 1)
  if (-not $expectedLine) { throw "Checksum entry not found for $nodeArchive" }
  $expectedHash = ($expectedLine -split '\s+')[0].ToUpperInvariant()
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
  if ($actualHash -ne $expectedHash) { throw 'Node.js archive checksum mismatch' }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $cacheDir -Force
}

$tsup = Join-Path $repoRoot 'node_modules\.bin\tsup.cmd'
if (-not (Test-Path -LiteralPath $tsup)) {
  Push-Location $repoRoot
  try {
    & pnpm.cmd install --frozen-lockfile --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}
Push-Location $repoRoot
try {
  & $tsup --config (Join-Path $prototypeRoot 'tsup.prototype.config.ts')
  if ($LASTEXITCODE -ne 0) { throw "tsup failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

if (-not $SkipRustBuild) {
  & (Join-Path $prototypeRoot 'build-rust.cmd')
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
}

$desktopExe = Join-Path $prototypeRoot 'src-tauri\target\release\cc-fix-desktop-prototype.exe'
if (-not (Test-Path -LiteralPath $desktopExe)) { throw "Desktop executable not found: $desktopExe" }

New-Item -ItemType Directory -Force -Path (Join-Path $outputDir 'runtime'), (Join-Path $outputDir 'app') | Out-Null
Copy-Item -LiteralPath $desktopExe -Destination (Join-Path $outputDir 'CC-Fix-Desktop-Prototype.exe') -Force
Copy-Item -LiteralPath $runtimeSource -Destination (Join-Path $outputDir 'runtime\node.exe') -Force
Copy-Item -LiteralPath (Join-Path $buildDir 'app\desktop-server.prototype.mjs') -Destination (Join-Path $outputDir 'app\desktop-server.prototype.mjs') -Force

Write-Host "Prototype ready: $outputDir"
Write-Host "Logs: $env:LOCALAPPDATA\CC-Fix\prototype\logs"
