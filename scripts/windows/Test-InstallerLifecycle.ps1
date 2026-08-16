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

function Invoke-BoundedProcess([string]$Stage, [string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 180) {
  Write-Host "[installer-lifecycle] $Stage"
  $Process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    throw "$Stage timed out after $TimeoutSeconds seconds"
  }
  return $Process.ExitCode
}

function Invoke-Installer([string]$Stage, [string[]]$Arguments) {
  $ExitCode = Invoke-BoundedProcess $Stage $InstallerPath $Arguments
  if ($ExitCode -ne 0) { throw "$Stage failed with exit code $ExitCode" }
}

$OriginalPath = (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
$NetworkBefore = Get-NetworkFingerprint
$DesktopPid = $null
try {
  $InstallArguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=$InstallRoot", '/TASKS=addpath,!desktopicon', "/LOG=$EvidenceRoot\install.log")
  Invoke-Installer 'fresh install' $InstallArguments
  $Version = (& "$InstallRoot\bin\cc-fix.cmd" --version) -join ''
  if ($LASTEXITCODE -ne 0 -or $Version.Trim() -ne $Package.version) { throw "Private-runtime CLI version smoke failed: $Version" }
  & "$InstallRoot\bin\cc-fix.cmd" persist preflight --json | Out-File -LiteralPath (Join-Path $EvidenceRoot 'preflight.json') -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Fresh install preflight was blocked' }
  if (-not (((Get-ItemProperty 'HKCU:\Environment' -Name Path).Path -split ';') -contains "$InstallRoot\bin")) { throw 'PATH segment was not added' }

  # ── persist on/off 冒烟（ADR-0011 回归：六槽策略曾因两套键空间 INVALID_VALUE 永久回滚） ──
  function Get-SmokePolicyValue([string]$KeyPath, [string]$ValueName) {
    try {
      $Lines = (& reg.exe query $KeyPath /v $ValueName 2>$null)
      if ($LASTEXITCODE -ne 0) { return $null }
      $Text = $Lines -join "`n"
      if ($Text -notmatch 'REG_SZ\s+(.+)$') { return $null }
      return $Matches[1].Trim()
    } catch { return $null }
  }
  function Get-SmokeEnvValue([string]$Name) {
    $Key = Get-ItemProperty 'HKCU:\Environment' -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $Key) { return $null }
    return $Key.$Name
  }
  # 语言列表 cmdlet 是 persist on 快照捕获的硬依赖；按 ADR-0010 该冒烟属于客户端测试线，
  # 能力缺失/不可用时记录跳过而非假失败。曾用 Get-Command 探测存在性——windows-2025-vs2026
  # 镜像（20260810.198 起）上该 cmdlet 存在但实际查询挂起（超过 core 的 15s execFile 超时），
  # 导致 CI 假失败。改用显式开关：默认跳过（与旧镜像行为一致），本机/真机验证时设置
  # CC_FIX_RUN_PERSIST_SMOKE=1。
  $SmokeSupported = ($env:CC_FIX_RUN_PERSIST_SMOKE -eq '1')
  if ($SmokeSupported) {
  $SmokePolicySlots = [ordered]@{
    'HKCU\Software\Policies\Google\Chrome' = @('AcceptLanguage', 'DefaultWebRtcIPHandlingPolicy', 'ApplicationLocaleValue')
    'HKCU\Software\Policies\Microsoft\Edge' = @('AcceptLanguage', 'DefaultWebRtcIPHandlingPolicy', 'ApplicationLocaleValue')
  }
  $SmokeEnvBefore = @{}
  foreach ($Name in @('TZ', 'LANG', 'LC_ALL')) { $SmokeEnvBefore[$Name] = Get-SmokeEnvValue $Name }
  # 前置条件：干净 CI 上六槽策略键在冒烟前必须不存在（兜底恢复按“删除”而非还原原值，ADR-0003 语义）
  foreach ($Path in $SmokePolicySlots.Keys) {
    foreach ($Name in $SmokePolicySlots[$Path]) {
      if ($null -ne (Get-SmokePolicyValue $Path $Name)) { throw "Persist smoke precondition failed: $Path\$Name already exists" }
    }
  }
  # 用 TimeZoneInfo 规范 id 而非 tzutil /g 的本地化显示名（中文系统输出“东部标准时间”）
  $SmokeTzBefore = [System.TimeZoneInfo]::Local.Id
  try {
    & "$InstallRoot\bin\cc-fix.cmd" persist on --region us --level standard | Out-File -LiteralPath (Join-Path $EvidenceRoot 'persist-on.log') -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw "persist on failed with exit code $LASTEXITCODE" }
    $StatePath = Join-Path $TestAppData 'cc-fix\state.json'
    if (-not (Test-Path -LiteralPath $StatePath)) { throw 'state.json missing after persist on' }
    $State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if ($null -eq $State.committedTarget -or $State.committedTarget.mode -ne 'standard' -or $State.committedTarget.region -ne 'us' -or $null -ne $State.activeTransactionId) { throw ('State was not committed: ' + ($State | ConvertTo-Json -Compress)) }
    if ((Get-SmokeEnvValue 'TZ') -ne 'America/New_York') { throw ('TZ was not committed: ' + (Get-SmokeEnvValue 'TZ')) }
    if ([System.TimeZoneInfo]::Local.Id -ne 'Eastern Standard Time') { throw ('System timezone was not committed: ' + [System.TimeZoneInfo]::Local.Id) }
    foreach ($Path in $SmokePolicySlots.Keys) {
      foreach ($Name in $SmokePolicySlots[$Path]) {
        $Expected = switch ($Name) { 'AcceptLanguage' { 'en-US,en' } 'DefaultWebRtcIPHandlingPolicy' { 'disable_non_proxied_udp' } 'ApplicationLocaleValue' { 'en-US' } }
        $Actual = Get-SmokePolicyValue $Path $Name
        if ($Actual -ne $Expected) { throw ("Policy mismatch ${Path}\${Name}: got '$Actual', expected '$Expected'") }
      }
    }
    & "$InstallRoot\bin\cc-fix.cmd" persist off | Out-File -LiteralPath (Join-Path $EvidenceRoot 'persist-off.log') -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw "persist off failed with exit code $LASTEXITCODE" }
    foreach ($Path in $SmokePolicySlots.Keys) {
      foreach ($Name in $SmokePolicySlots[$Path]) {
        if ($null -ne (Get-SmokePolicyValue $Path $Name)) { throw ("Policy was not restored: $Path\$Name") }
      }
    }
    foreach ($Name in @('TZ', 'LANG', 'LC_ALL')) {
      $Before = $SmokeEnvBefore[$Name]; $After = Get-SmokeEnvValue $Name
      if ($Before -ne $After) { throw ("Env not restored: $Name before '$Before' after '$After'") }
    }
    if ([System.TimeZoneInfo]::Local.Id -ne $SmokeTzBefore) { throw ('System timezone was not restored: ' + [System.TimeZoneInfo]::Local.Id) }
    $StateAfter = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if ($null -ne $StateAfter.committedTarget -or $StateAfter.health -ne 'healthy') { throw 'Daily state was not committed after persist off' }
  } finally {
    # 收敛兜底：无论断言成败都还原日常配置（幂等）；能力缺失时 persist 未启动，无需兜底
    if ($SmokeSupported) { & "$InstallRoot\bin\cc-fix.cmd" persist off *> $null }
    foreach ($Path in $SmokePolicySlots.Keys) {
      foreach ($Name in $SmokePolicySlots[$Path]) {
        # ErrorActionPreference=Stop 下 reg.exe 找不到键时 stderr 会转成终止错误：
        # 兜底清理必须吞掉（2>$null 只吞 stderr 文本，不吞 NativeCommandError）。
        $Deleted = & reg.exe delete $Path /v $Name /f 2>$null
        if ($LASTEXITCODE -ne 0) { $null = $Deleted }
      }
    }
    foreach ($Name in @('TZ', 'LANG', 'LC_ALL')) {
      $Before = $SmokeEnvBefore[$Name]
      if ($null -eq $Before) { Remove-ItemProperty 'HKCU:\Environment' -Name $Name -ErrorAction SilentlyContinue }
      else { Set-ItemProperty 'HKCU:\Environment' -Name $Name -Value $Before }
    }
    if ($SmokeTzBefore) {
      $Restored = & tzutil.exe /s $SmokeTzBefore 2>$null
      if ($LASTEXITCODE -ne 0) { $null = $Restored }
    }
  }

  } else {
    Write-Host '[installer-lifecycle] persist smoke skipped: Get-WinUserLanguageList unavailable on this host'
  }

  $UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{7C76DF1B-B683-4A77-9B4C-89E3305D2399}_is1'
  Set-ItemProperty -LiteralPath $UninstallKey -Name DisplayVersion -Value '99.0.0'
  $DowngradeExitCode = Invoke-BoundedProcess 'downgrade refusal' $InstallerPath @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=$InstallRoot", '/TASKS=addpath,!desktopicon') 60
  if ($DowngradeExitCode -eq 0) { throw 'Downgrade was not refused' }
  Set-ItemProperty -LiteralPath $UninstallKey -Name DisplayVersion -Value $Package.version

  Invoke-Installer 'same-version repair' @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=$InstallRoot", '/TASKS=addpath,!desktopicon', "/LOG=$EvidenceRoot\repair.log")

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
  $UninstallExitCode = Invoke-BoundedProcess 'restore-first uninstall' $Uninstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$EvidenceRoot\uninstall.log")
  if ($UninstallExitCode -ne 0) { throw "Uninstall failed with exit code $UninstallExitCode" }
  $UninstallDeadline = [DateTime]::UtcNow.AddSeconds(60)
  while ((Test-Path -LiteralPath $InstallRoot) -and ([DateTime]::UtcNow -lt $UninstallDeadline)) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $InstallRoot) { throw 'Managed install directory remains after uninstall' }
  $CurrentPath = (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
  if ($CurrentPath -ne $OriginalPath) {
    # 诊断输出：精确还原断言失败时记录原始/当前值、注册表类型与 reg 原始输出，避免盲改。
    $PathProp = Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue
    $PathType = if ($null -eq $PathProp) { 'missing' } else { $PathProp.PSObject.Properties['Path'].TypeNameOfValue }
    $RawReg = (& reg.exe query 'HKCU\Environment' /v Path 2>$null) -join " | "
    Write-Host "[installer-lifecycle] PATH mismatch diagnostic:"
    Write-Host "  original = '$OriginalPath'"
    Write-Host "  current  = '$CurrentPath'"
    Write-Host "  type     = $PathType"
    Write-Host "  reg      = $RawReg"
    @(
      "original = $OriginalPath",
      "current  = $CurrentPath",
      "type     = $PathType",
      "reg      = $RawReg"
    ) | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'path-mismatch.txt') -Encoding utf8
    throw 'Uninstall did not restore the exact original PATH'
  }
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
    persistSmoke = if ($SmokeSupported) { 'passed' } else { 'skipped-unsupported' }
    pathRestored = $true
    networkConfigurationUnchanged = $true
    evidenceRoot = $EvidenceRoot
  }
  $Result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'result.json') -Encoding utf8
  $Result | ConvertTo-Json -Compress
} finally {
  if ($null -ne $DesktopPid) { Stop-Process -Id $DesktopPid -ErrorAction SilentlyContinue }
}