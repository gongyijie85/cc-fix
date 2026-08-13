param([string]$InstallerPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$RepositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Package = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw | ConvertFrom-Json
if (-not $InstallerPath) {
  $InstallerPath = Join-Path $RepositoryRoot "release\installer\CC-Fix-Setup-$($Package.version)-x64.exe"
}
$InstallerPath = [IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $InstallerPath)) { throw "Installer not found: $InstallerPath" }

$RunId = [Guid]::NewGuid().ToString('N')
$EvidenceRoot = Join-Path $RepositoryRoot ".wayfinder\temp\installer-lifecycle-$RunId"
$InstallRoot = Join-Path $EvidenceRoot 'install'
$TestAppData = Join-Path $EvidenceRoot 'appdata'
New-Item -ItemType Directory -Force -Path $TestAppData | Out-Null
$env:APPDATA = $TestAppData

function Get-TextHash([string]$Value) {
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $Bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    return ([BitConverter]::ToString($Hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally { $Hasher.Dispose() }
}

function Get-NetworkFingerprint {
  $Adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Sort-Object InterfaceGuid | Select-Object InterfaceGuid, Status, MacAddress)
  $Dns = @(Get-DnsClientServerAddress -ErrorAction SilentlyContinue | Sort-Object InterfaceIndex, AddressFamily | Select-Object InterfaceIndex, AddressFamily, ServerAddresses)
  $Routes = @(Get-NetRoute -ErrorAction SilentlyContinue | Sort-Object InterfaceIndex, DestinationPrefix, NextHop | Select-Object InterfaceIndex, DestinationPrefix, NextHop, RouteMetric)
  $Vpn = @(Get-VpnConnection -AllUserConnection -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object Name, ServerAddress, TunnelType)
  return Get-TextHash ((@{ adapters = $Adapters; dns = $Dns; routes = $Routes; vpn = $Vpn } | ConvertTo-Json -Depth 6 -Compress))
}

function Invoke-Installer([string[]]$Arguments) {
  $Process = Start-Process -FilePath $InstallerPath -ArgumentList $Arguments -WindowStyle Hidden -Wait -PassThru
  if ($Process.ExitCode -ne 0) { throw "Installer failed with exit code $($Process.ExitCode)" }
}

$OriginalPath = (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
$NetworkBefore = Get-NetworkFingerprint
$DesktopPid = $null
try {
  $InstallArguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=$InstallRoot", '/TASKS=addpath,!desktopicon', "/LOG=$EvidenceRoot\install.log")
  Invoke-Installer $InstallArguments
  $Version = (& "$InstallRoot\bin\cc-fix.cmd" --version) -join ''
  if ($LASTEXITCODE -ne 0 -or $Version.Trim() -ne $Package.version) { throw "Private-runtime CLI version smoke failed: $Version" }
  & "$InstallRoot\bin\cc-fix.cmd" persist preflight --json | Out-File -LiteralPath (Join-Path $EvidenceRoot 'preflight.json') -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Fresh install preflight was blocked' }
  if (-not (((Get-ItemProperty 'HKCU:\Environment' -Name Path).Path -split ';') -contains "$InstallRoot\bin")) { throw 'PATH segment was not added' }

  $UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{7C76DF1B-B683-4A77-9B4C-89E3305D2399}_is1'
  Set-ItemProperty -LiteralPath $UninstallKey -Name DisplayVersion -Value '99.0.0'
  $Downgrade = Start-Process -FilePath $InstallerPath -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=$InstallRoot", '/TASKS=addpath,!desktopicon') -WindowStyle Hidden -Wait -PassThru
  if ($Downgrade.ExitCode -eq 0) { throw 'Downgrade was not refused' }
  Set-ItemProperty -LiteralPath $UninstallKey -Name DisplayVersion -Value $Package.version

  Invoke-Installer @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=$InstallRoot", '/TASKS=addpath,!desktopicon', "/LOG=$EvidenceRoot\repair.log")

  $Desktop = Start-Process -FilePath "$InstallRoot\CC-Fix.exe" -WindowStyle Hidden -PassThru
  $DesktopPid = $Desktop.Id
  Start-Sleep -Seconds 3
  $Children = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $DesktopPid -and $_.Name -eq 'node.exe' })
  if ($Children.Count -ne 1) { throw "Expected one private Node sidecar, received $($Children.Count)" }
  Start-Process -FilePath "$InstallRoot\CC-Fix.exe" -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
  $DesktopCount = @(Get-Process -Name 'CC-Fix' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$InstallRoot\CC-Fix.exe" }).Count
  if ($DesktopCount -ne 1) { throw "Single-instance check failed: $DesktopCount" }
  Stop-Process -Id $DesktopPid
  $DesktopPid = $null
  Start-Sleep -Seconds 2
  if (@($Children | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count -ne 0) { throw 'Private Node sidecar survived desktop exit' }

  $Uninstaller = Join-Path $InstallRoot 'unins000.exe'
  $Process = Start-Process -FilePath $Uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$EvidenceRoot\uninstall.log") -WindowStyle Hidden -Wait -PassThru
  if ($Process.ExitCode -ne 0) { throw "Uninstall failed with exit code $($Process.ExitCode)" }
  if (Test-Path -LiteralPath $InstallRoot) { throw 'Managed install directory remains after uninstall' }
  $CurrentPath = (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
  if ($CurrentPath -ne $OriginalPath) { throw 'Uninstall did not restore the exact original PATH' }
  $NetworkAfter = Get-NetworkFingerprint
  if ($NetworkAfter -ne $NetworkBefore) { throw 'VPN/route/adapter/DNS configuration fingerprint changed during lifecycle' }

  $Result = [ordered]@{
    schemaVersion = 1
    version = $Package.version
    result = 'passed'
    privateRuntime = $true
    repair = $true
    downgradeRefused = $true
    singleInstance = $true
    sidecarReaped = $true
    pathRestored = $true
    networkConfigurationUnchanged = $true
    evidenceRoot = $EvidenceRoot
  }
  $Result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'result.json') -Encoding utf8
  $Result | ConvertTo-Json -Compress
} finally {
  if ($null -ne $DesktopPid) { Stop-Process -Id $DesktopPid -ErrorAction SilentlyContinue }
}
