$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Package = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw | ConvertFrom-Json
$Payload = Join-Path $RepositoryRoot 'release\payload'
$Output = Join-Path $RepositoryRoot 'release\installer'
$IsccCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
)
$Iscc = $IsccCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $Iscc) { throw 'Inno Setup 6.7.x is required; install the exact toolchain.lock.json artifact first.' }
$Toolchain = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
$UserInno = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1' -ErrorAction SilentlyContinue
$MachineInno = Get-ItemProperty 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1' -ErrorAction SilentlyContinue
$InstalledInno = @($UserInno, $MachineInno) | Where-Object {
  $_ -and ([IO.Path]::GetFullPath($_.InstallLocation).TrimEnd('\') -eq [IO.Path]::GetFullPath((Split-Path -Parent $Iscc)).TrimEnd('\'))
} | Select-Object -First 1
$IsccVersion = if ($InstalledInno) { $InstalledInno.DisplayVersion } else { '' }
if ($IsccVersion -ne $Toolchain.tools.innoSetup.version) {
  throw "ISCC must exactly match $($Toolchain.tools.innoSetup.version); received $IsccVersion"
}

function Get-Sha256([string]$Path) {
  $Stream = [IO.File]::OpenRead($Path)
  try {
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
    finally { $Hasher.Dispose() }
  } finally { $Stream.Dispose() }
}

Push-Location $RepositoryRoot
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'scripts\build-windows-payload.ps1'
  if ($LASTEXITCODE -ne 0) { throw "Payload build failed with exit code $LASTEXITCODE" }
  New-Item -ItemType Directory -Force -Path $Output | Out-Null
  & $Iscc "/DAppVersion=$($Package.version)" "/DPayloadDir=$Payload" "/DOutputDir=$Output" 'packaging\windows-installer.iss'
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }
  $Installer = Join-Path $Output "CC-Fix-Setup-$($Package.version)-x64.exe"
  if (-not (Test-Path -LiteralPath $Installer)) { throw 'Expected installer was not produced' }
  $Hash = Get-Sha256 $Installer
  Set-Content -LiteralPath "$Installer.sha256" -Value "$Hash  $([IO.Path]::GetFileName($Installer))" -Encoding ascii
  Write-Host "Installer ready: $Installer"
  Write-Host "SHA-256: $Hash"
} finally {
  Pop-Location
}
