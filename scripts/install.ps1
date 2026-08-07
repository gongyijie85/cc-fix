# cc-fix 一键安装脚本 (Windows PowerShell)
# 使用方法：右键 → 使用 PowerShell 运行
# 或打开 PowerShell 后粘贴执行

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host "    cc-fix 一键安装工具 v0.1.0" -ForegroundColor Cyan
Write-Host "    Claude Code 环境安全检测与修复" -ForegroundColor Cyan
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host ""

# 检查 Node.js
$nodeVersion = $null
try {
    $nodeVersion = node -v 2>$null
} catch {}

if (-not $nodeVersion) {
    Write-Host "  [!] 未检测到 Node.js，需要先安装" -ForegroundColor Red
    Write-Host ""
    Write-Host "  请前往 https://nodejs.org 下载安装 Node.js (v20+)" -ForegroundColor Yellow
    Write-Host "  安装完成后重新运行此脚本" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  按任意键打开 Node.js 下载页面..." -ForegroundColor Gray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    Start-Process "https://nodejs.org"
    exit 1
}

Write-Host "  [OK] Node.js $nodeVersion" -ForegroundColor Green

# 安装 cc-fix
Write-Host ""
Write-Host "  正在安装 cc-fix..." -ForegroundColor Cyan
Write-Host ""

npm install -g cc-fix 2>&1 | ForEach-Object { Write-Host "  $_" }

# 生成桌面快捷方式（直达 cc-fix gui 面板）
# 优先全局命令；无全局命令时回退到仓库本地构建产物
function New-CcFixShortcut {
    try {
        $repoRoot = Split-Path -Parent $PSScriptRoot
        $localEntry = Join-Path $repoRoot "dist\index.js"

        $globalCmd = Get-Command cc-fix -ErrorAction SilentlyContinue
        if ($globalCmd) {
            $targetPath = "cmd.exe"
            $arguments = "/c cc-fix gui"
        } elseif (Test-Path $localEntry) {
            $targetPath = "cmd.exe"
            $arguments = "/c node `"$localEntry`" gui"
        } else {
            Write-Host "  [!] 未找到 cc-fix 可执行入口，跳过快捷方式" -ForegroundColor Yellow
            return
        }

        $desktop = [Environment]::GetFolderPath("Desktop")
        $lnk = Join-Path $desktop "CC-Fix 面板.lnk"
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($lnk)
        $shortcut.TargetPath = $targetPath
        $shortcut.Arguments = $arguments
        $shortcut.Description = "CC-Fix 环境安全检测面板"
        $shortcut.Save()
        Write-Host "  [OK] 桌面快捷方式已创建：CC-Fix 面板" -ForegroundColor Green
    } catch {
        Write-Host "  [!] 桌面快捷方式创建失败：$_" -ForegroundColor Yellow
    }
}

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "    安装成功！" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  使用方法：" -ForegroundColor White
    Write-Host "    cc-fix check          检测环境风险" -ForegroundColor Yellow
    Write-Host "    cc-fix persist on     一键切换到安全环境" -ForegroundColor Yellow
    Write-Host "    cc-fix proxy check    检测出口 IP" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  提示：双击桌面“CC-Fix 面板”快捷方式可直接打开可视化面板" -ForegroundColor Gray
    Write-Host ""
    New-CcFixShortcut
} else {
    Write-Host ""
    Write-Host "  [!] 安装失败，尝试使用 npx 直接运行..." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  你可以直接用以下命令运行（无需安装）：" -ForegroundColor White
    Write-Host "    npx cc-fix check" -ForegroundColor Yellow
    Write-Host ""
    New-CcFixShortcut
}

Write-Host "  按任意键退出..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
