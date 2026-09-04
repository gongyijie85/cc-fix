// 特权助手（issue #49 安全强化）：脚本与参数经 -EncodedCommand 编入命令行快照，
// 磁盘上不存在可替换的 font-helper.ps1 / font-helper-args.json。
// 提权端（PowerShell）再做一层锚定与白名单校验：备份目录与注册表 JSON 必须
// 位于 font-backup 子树内、拒绝 reparse point、注册表值逐项白名单后写回固定键
// （弃用 reg.exe import 任意导入）。

import { CHINESE_FONT_PATTERNS } from './catalog.js';

/** 备份目录内的注册表还原材料文件名（唯一合法名）。 */
export const FONT_REGISTRY_JSON_NAME = 'fonts-hklm.json';

/** PowerShell 单引号字符串字面量（内部 ' → ''）。 */
function psSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** -EncodedCommand 载荷：UTF-16LE → base64。 */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export type ElevatedFontRequest = Readonly<{
  mode: 'remove';
  expectedNames: readonly string[];
}> | Readonly<{
  mode: 'restore';
  /** restore：字体文件备份子目录（必须锚定 anchorRoot 子树）。 */
  backupDir?: string;
  /** restore：注册表 JSON 路径（必须锚定 anchorRoot 子树且文件名固定）。 */
  regJsonPath?: string;
  /** restore：仅撤销本产品此前登记的待重启删除项。 */
  scheduledDeleteNames?: readonly string[];
}>;

/**
 * 组装提权脚本。参数以 JSON 字面量内嵌（命令行只读快照，同用户进程无法篡改）；
 * 删除名单来自刚完成备份的 manifest；提权端重新枚举并要求精确相等。
 */
export function composeElevatedFontScript(options: Readonly<{
  request: ElevatedFontRequest;
  anchorRoot: string;
  markerPath: string;
  nonce: string;
}>): string {
  const patterns = CHINESE_FONT_PATTERNS.join('|');
  return [
    "$ErrorActionPreference = 'Continue'",
    `$nonce = ${psSingle(options.nonce)}`,
    `$markerPath = ${psSingle(options.markerPath)}`,
    `$anchor = ${psSingle(options.anchorRoot.endsWith('\\') ? options.anchorRoot : options.anchorRoot + '\\')}`,
    "$fontsDir = Join-Path $env:SystemRoot 'Fonts'",
    "$fontKey = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'",
    `$req = ${psSingle(JSON.stringify(options.request))} | ConvertFrom-Json`,
    "$cmp = [StringComparison]::OrdinalIgnoreCase",
    "function Send-WM_FONTCHANGE {",
    "  $broadcast = [IntPtr]0xffff",
    "  $WM_FONTCHANGE = 0x001D",
    "  $result = [UIntPtr]::Zero",
    "  $null = [CCFontNative]::SendMessageTimeout($broadcast, $WM_FONTCHANGE, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 5000, [ref]$result)",
    "}",
    "function Assert-Anchored([string]$p, [string]$what) {",
    "  $full = [IO.Path]::GetFullPath($p)",
    "  if (-not $full.StartsWith($anchor, $cmp)) { throw ($what + ' escapes the backup anchor: ' + $p) }",
    "  return $full",
    "}",
    "function Write-Marker([hashtable]$m) { $m.nonce = $nonce; $m | ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding utf8 }",
    "try {",
    "  Add-Type -ErrorAction Stop -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class CCFontNative {",
    "  [DllImport(\"gdi32.dll\", CharSet = CharSet.Unicode)] public static extern int AddFontResource(string path);",
    "  [DllImport(\"gdi32.dll\", CharSet = CharSet.Unicode)] public static extern bool RemoveFontResource(string path);",
    "  [DllImport(\"user32.dll\", SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);",
    "}",
    "'@",
    "  if ($req.mode -eq 'remove') {",
    "    $expectedNames = @($req.expectedNames | ForEach-Object { [string]$_ })",
    "    if ($expectedNames.Count -eq 0) { throw 'remove inventory is empty' }",
    "    foreach ($name in $expectedNames) {",
    "      if ($name -notmatch '^[\\w.-]+\\.(ttf|ttc)$') { throw ('invalid expected font name: ' + $name) }",
    "    }",
    "    $names = @(Get-ChildItem -LiteralPath $fontsDir | Where-Object { $_.Name -match '" + patterns + "' } | ForEach-Object { $_.Name })",
    "    foreach ($name in $names) {",
    "      if ($name -notmatch '^[\\w.-]+\\.(ttf|ttc)$') { throw ('invalid font name: ' + $name) }",
    "    }",
    "    $expectedNormalized = @($expectedNames | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object -Unique)",
    "    $actualNormalized = @($names | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object -Unique)",
    "    if ($expectedNormalized.Count -ne $expectedNames.Count -or @(Compare-Object $expectedNormalized $actualNormalized).Count -ne 0) { throw 'font inventory changed after backup' }",
    "    $pendingReboot = @()",
    "    $scheduledDeleteNames = @()",
    "    foreach ($name in $names) {",
    "      $full = Join-Path $fontsDir $name",
    "      if (Test-Path -LiteralPath $full) {",
    "        $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop",
    "        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('reparse point in fonts dir: ' + $name) }",
    "        if ($item.PSIsContainer) { throw ('unexpected directory in fonts dir: ' + $name) }",
    "        $null = [CCFontNative]::RemoveFontResource($full)",
    "        try { Remove-Item -LiteralPath $full -Force -ErrorAction Stop }",
    "        catch { $pendingReboot += $name }",
    "      }",
    "    }",
    "    foreach ($v in (Get-Item $fontKey).Property) {",
    "      $data = (Get-ItemProperty $fontKey -Name $v).$v",
    "      if ($data -and ($names -contains [IO.Path]::GetFileName([string]$data))) {",
    "        try { Remove-ItemProperty $fontKey -Name $v -ErrorAction Stop } catch {}",
    "      }",
    "    }",
    "    if ($pendingReboot.Count -gt 0) {",
    "      $key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager'",
    "      $existing = @((Get-ItemProperty $key -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations)",
    "      $existingDeleteSources = @{}",
    "      for ($i = 0; $i -lt $existing.Count; $i += 2) {",
    "        $source = [string]$existing[$i]",
    "        $destination = if ($i + 1 -lt $existing.Count) { [string]$existing[$i + 1] } else { '' }",
    "        if ($destination -eq '') { $existingDeleteSources[$source.ToLowerInvariant()] = $true }",
    "      }",
    "      $entries = @()",
    "      foreach ($name in $pendingReboot) {",
    "        $source = '\\??\\' + (Join-Path $fontsDir $name)",
    "        if (-not $existingDeleteSources.ContainsKey($source.ToLowerInvariant())) {",
    "          $entries += $source; $entries += ''; $scheduledDeleteNames += $name",
    "          $existingDeleteSources[$source.ToLowerInvariant()] = $true",
    "        }",
    "      }",
    "      if ($entries.Count -gt 0) { Set-ItemProperty $key -Name PendingFileRenameOperations -Value ($existing + $entries) -Type MultiString -ErrorAction Stop }",
    "    }",
    "    Send-WM_FONTCHANGE",
    "    Write-Marker @{ ok = $true; pendingReboot = $pendingReboot; scheduledDeleteNames = $scheduledDeleteNames }",
    "  } elseif ($req.mode -eq 'restore') {",
    "    $backupDir = Assert-Anchored ([string]$req.backupDir) 'backup dir'",
    "    $files = @(Get-ChildItem -LiteralPath $backupDir -Force)",
    "    foreach ($f in $files) {",
    "      if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('reparse point in backup: ' + $f.Name) }",
    "      if ($f.Name -notmatch '^[\\w.-]+\\.(ttf|ttc)$') { throw ('unexpected file in backup: ' + $f.Name) }",
    "    }",
    "    foreach ($f in $files) {",
    "      $destination = Join-Path $fontsDir $f.Name",
    "      Copy-Item -LiteralPath $f.FullName -Destination $destination -Force",
    "      $null = [CCFontNative]::AddFontResource($destination)",
    "    }",
    "    if ($req.regJsonPath) {",
    "      $regJson = Assert-Anchored ([string]$req.regJsonPath) 'registry json'",
    "      if ([IO.Path]::GetFileName($regJson) -ne 'fonts-hklm.json') { throw 'unexpected registry json name' }",
    "      $ri = Get-Item -LiteralPath $regJson -Force",
    "      if ($ri.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'registry json is a reparse point' }",
    "      $entries = (Get-Content -LiteralPath $regJson -Raw | ConvertFrom-Json).entries",
    "      if ($entries) {",
    "        foreach ($p in $entries.PSObject.Properties) {",
    "          $name = [string]$p.Name",
    "          $data = [string]$p.Value",
    "          if ($name -notmatch '^[^\\\\/:*?\"<>|\\x00-\\x1F]{1,200}$') { throw ('unsafe registry value name: ' + $name) }",
    "          $dataOk = ($data -match '^[^\\\\/:*?\"<>|\\x00-\\x1F]{1,260}$') -and (($data -notmatch '\\\\') -or $data.StartsWith($fontsDir + '\\', $cmp))",
    "          if (-not $dataOk) { throw ('unsafe registry value data: ' + $data) }",
    "          New-ItemProperty -Path $fontKey -Name $name -Value $data -PropertyType String -Force | Out-Null",
    "        }",
    "      }",
    "    }",
    "    $scheduledDeleteNames = @($req.scheduledDeleteNames | ForEach-Object { [string]$_ })",
    "    if ($scheduledDeleteNames.Count -gt 0) {",
    "      $ownedDeleteSources = @{}",
    "      foreach ($name in $scheduledDeleteNames) {",
    "        if ($name -notmatch '^[\\w.-]+\\.(ttf|ttc)$') { throw ('invalid scheduled font name: ' + $name) }",
    "        $sourceKey = ('\\??\\' + (Join-Path $fontsDir $name)).ToLowerInvariant()",
    "        if ($ownedDeleteSources.ContainsKey($sourceKey)) { $ownedDeleteSources[$sourceKey]++ } else { $ownedDeleteSources[$sourceKey] = 1 }",
    "      }",
    "      $key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager'",
    "      $existing = @((Get-ItemProperty $key -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations)",
    "      $kept = @()",
    "      for ($i = 0; $i -lt $existing.Count; $i += 2) {",
    "        $source = [string]$existing[$i]",
    "        $destination = if ($i + 1 -lt $existing.Count) { [string]$existing[$i + 1] } else { '' }",
    "        $sourceKey = $source.ToLowerInvariant()",
    "        $ownedDelete = ($destination -eq '') -and $ownedDeleteSources.ContainsKey($sourceKey) -and ($ownedDeleteSources[$sourceKey] -gt 0)",
    "        if ($ownedDelete) { $ownedDeleteSources[$sourceKey]-- } else { $kept += $source; $kept += $destination }",
    "      }",
    "      if ($kept.Count -gt 0) { Set-ItemProperty $key -Name PendingFileRenameOperations -Value $kept -Type MultiString -ErrorAction Stop }",
    "      elseif ($existing.Count -gt 0) { Remove-ItemProperty $key -Name PendingFileRenameOperations -ErrorAction Stop }",
    "    }",
    "    Send-WM_FONTCHANGE",
    "    Write-Marker @{ ok = $true; pendingReboot = @(); scheduledDeleteNames = @() }",
    "  } else { throw 'unknown mode' }",
    "} catch {",
    "  Write-Marker @{ ok = $false; error = ([string]$_.Exception.Message) }",
    "}",
  ].join('\n');
}

/**
 * 外层启动器 argv：spawn 非提权 powershell，由它 Start-Process -Verb RunAs 提权
 * 运行内层（内层脚本走 -EncodedCommand，避免转义；外层语句短，直接 -Command）。
 * 命令行总长约等于内层 base64（~11KB），远离 CreateProcess 32K 上限。
 */
export function buildElevationLauncherArgs(script: string): string[] {
  const inner = encodePowerShellCommand(script);
  const launcher = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${inner}')`;
  return ['-NoProfile', '-NonInteractive', '-Command', launcher];
}
