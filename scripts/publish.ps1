# cc-fix npm publish helper — run after `npm login`
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [string[]] $Arguments
    )

    & $Name @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Native command failed ($LASTEXITCODE): $Name $($Arguments -join ' ')"
    }
}

Write-Host "==> release validation" -ForegroundColor Cyan
Invoke-NativeCommand -Name "pnpm" -Arguments @("release:validate")

Write-Host "==> whoami" -ForegroundColor Cyan
Invoke-NativeCommand -Name "npm" -Arguments @("whoami")

Write-Host "==> typecheck + test + build" -ForegroundColor Cyan
Invoke-NativeCommand -Name "pnpm" -Arguments @("typecheck")
Invoke-NativeCommand -Name "pnpm" -Arguments @("test")
Invoke-NativeCommand -Name "pnpm" -Arguments @("build")

Write-Host "==> dry-run pack" -ForegroundColor Cyan
Invoke-NativeCommand -Name "npm" -Arguments @("pack", "--dry-run")

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
Write-Host "==> publish $version public" -ForegroundColor Cyan
Invoke-NativeCommand -Name "npm" -Arguments @("publish", "--access", "public")

Write-Host "==> verify" -ForegroundColor Cyan
Invoke-NativeCommand -Name "npm" -Arguments @("view", "cc-fix", "version")
Write-Host "OK: https://www.npmjs.com/package/cc-fix" -ForegroundColor Green
