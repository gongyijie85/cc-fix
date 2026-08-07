# cc-fix npm publish helper — run after `npm login`
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host "==> whoami" -ForegroundColor Cyan
npm whoami

Write-Host "==> typecheck + test + build" -ForegroundColor Cyan
pnpm typecheck
pnpm test
pnpm build

Write-Host "==> dry-run pack" -ForegroundColor Cyan
npm pack --dry-run

Write-Host "==> publish 0.1.0 public" -ForegroundColor Cyan
npm publish --access public

Write-Host "==> verify" -ForegroundColor Cyan
npm view cc-fix version
Write-Host "OK: https://www.npmjs.com/package/cc-fix" -ForegroundColor Green
