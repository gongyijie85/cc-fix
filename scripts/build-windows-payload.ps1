$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Lock = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
$Package = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw | ConvertFrom-Json
$CacheRoot = Join-Path $RepositoryRoot '.wayfinder\temp\toolchain'
$ReleaseRoot = Join-Path $RepositoryRoot 'release'
$PayloadRoot = Join-Path $ReleaseRoot 'payload'

function Invoke-Native([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}

function Get-Tool([string]$Name) { return $Lock.tools.$Name }

function Get-Sha256([string]$Path) {
  $Stream = [IO.File]::OpenRead($Path)
  try {
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
    finally { $Hasher.Dispose() }
  } finally { $Stream.Dispose() }
}

function Get-Artifact([string]$Name, [string]$FileName) {
  $Tool = Get-Tool $Name
  $Destination = Join-Path $CacheRoot $FileName
  New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
  if (-not (Test-Path -LiteralPath $Destination)) {
    Invoke-WebRequest -Uri $Tool.source -OutFile $Destination -UseBasicParsing
  }
  $Actual = Get-Sha256 $Destination
  if ($Actual -ne $Tool.sha256.ToLowerInvariant()) {
    throw "$Name digest mismatch: expected $($Tool.sha256), received $Actual"
  }
  return $Destination
}

Push-Location $RepositoryRoot
try {
  Invoke-Native 'pnpm.cmd' @('check:toolchain')
  Invoke-Native 'pnpm.cmd' @('check:version')
  Invoke-Native 'pnpm.cmd' @('typecheck')
  Invoke-Native 'pnpm.cmd' @('build')
  $RustVersion = (& rustc.exe --version).Split(' ')[1]
  if ($LASTEXITCODE -ne 0 -or $RustVersion -ne $Lock.tools.rust.version) {
    throw "rustc must exactly match $($Lock.tools.rust.version); received $RustVersion"
  }
  Invoke-Native 'cargo.exe' @('build', '--release', '--locked', '--manifest-path', 'native-helper\Cargo.toml')
  Invoke-Native 'cargo.exe' @('build', '--release', '--locked', '--manifest-path', 'src-tauri\Cargo.toml')

  $NodeArchive = Get-Artifact 'node' "node-v$($Lock.tools.node.version)-win-x64.zip"
  $WebViewInstaller = Get-Artifact 'webView2' 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'

  $ResolvedRelease = [IO.Path]::GetFullPath($ReleaseRoot)
  $ResolvedExpected = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot 'release'))
  if ($ResolvedRelease -ne $ResolvedExpected) { throw 'Refusing to replace an unexpected release directory' }
  if (Test-Path -LiteralPath $ReleaseRoot) { Remove-Item -LiteralPath $ReleaseRoot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $PayloadRoot | Out-Null
  foreach ($Directory in 'bin','core','native','runtime','redist') {
    New-Item -ItemType Directory -Force -Path (Join-Path $PayloadRoot $Directory) | Out-Null
  }

  $NodeExtract = Join-Path $RepositoryRoot '.wayfinder\temp\node-runtime'
  if (Test-Path -LiteralPath $NodeExtract) { Remove-Item -LiteralPath $NodeExtract -Recurse -Force }
  Expand-Archive -LiteralPath $NodeArchive -DestinationPath $NodeExtract
  $NodeRoot = Get-ChildItem -LiteralPath $NodeExtract -Directory | Select-Object -First 1
  Copy-Item -LiteralPath (Join-Path $NodeRoot.FullName 'node.exe') -Destination (Join-Path $PayloadRoot 'runtime\node.exe')
  Copy-Item -LiteralPath (Join-Path $NodeRoot.FullName 'LICENSE') -Destination (Join-Path $PayloadRoot 'runtime\NODE-LICENSE.txt')
  # splitting 启用后 dist 含共享 chunk；整个 JS 树镜像到 core/，保持 index.js/gui/sidecar.js 相对导入可用。
  Get-ChildItem -LiteralPath 'dist' -Recurse -Filter '*.js' | ForEach-Object {
    $Relative = $_.FullName.Substring((Resolve-Path 'dist').Path.Length + 1)
    $Destination = Join-Path $PayloadRoot "core\$Relative"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $Destination
  }
  Copy-Item -LiteralPath 'native-helper\target\release\cc-fix-native-helper.exe' -Destination (Join-Path $PayloadRoot 'native\cc-fix-native-helper.exe')
  # issue #53：helper 哈希 sidecar——运行期 resolveNativeHelperPath 校验（篡改可见性，fail-closed）
  # Windows PowerShell + StrictMode can treat an interpolated assignment as
  # uninitialized when the hash helper returns through nested finally blocks;
  # write the verified digest directly to avoid producing a missing sidecar.
  (Get-Sha256 (Join-Path $PayloadRoot 'native\cc-fix-native-helper.exe')) |
    Set-Content -LiteralPath (Join-Path $PayloadRoot 'native\cc-fix-native-helper.exe.sha256') -Encoding ascii
  Copy-Item -LiteralPath 'src-tauri\target\release\cc-fix-desktop.exe' -Destination (Join-Path $PayloadRoot 'CC-Fix.exe')
  Copy-Item -LiteralPath 'packaging\cc-fix.cmd' -Destination (Join-Path $PayloadRoot 'bin\cc-fix.cmd')
  Copy-Item -LiteralPath 'LICENSE' -Destination (Join-Path $PayloadRoot 'LICENSE.txt')
  # The sidecar serves GUI CSS/JS/fonts relative to the install root. Keep
  # these resources in the installer payload alongside core/ and runtime/.
  Copy-Item -LiteralPath 'assets' -Destination (Join-Path $PayloadRoot 'assets') -Recurse
  Copy-Item -LiteralPath $WebViewInstaller -Destination (Join-Path $PayloadRoot 'redist\MicrosoftEdgeWebView2RuntimeInstallerX64.exe')

  Invoke-Native 'node.exe' @('scripts\verify-windows-payload.mjs', '--write')
  Invoke-Native 'node.exe' @('scripts\verify-windows-payload.mjs')
  $BundledVersion = & (Join-Path $PayloadRoot 'runtime\node.exe') (Join-Path $PayloadRoot 'core\index.js') '--version'
  if ($LASTEXITCODE -ne 0 -or ($BundledVersion -join '').Trim() -ne $Package.version) {
    throw "Bundled CLI smoke test failed; expected $($Package.version), received $($BundledVersion -join '')"
  }
  Write-Host "Windows payload ready: $PayloadRoot"
} finally {
  Pop-Location
}
