@echo off
chcp 65001 >nul 2>&1
title cc-fix - Claude Code 环境安全检测

where cc-fix >nul 2>&1
if errorlevel 1 (
  echo This legacy menu requires the npm CLI. Use the recommended CC-Fix Windows installer instead.
  exit /b 78
)

:menu
cls
echo.
echo   ========================================
echo     cc-fix - Claude Code 环境安全工具
echo   ========================================
echo.
echo     1. 检测环境风险
echo     2. 开启标准保护（会修改环境变量、系统时区和浏览器策略）
echo     3. 恢复原始环境（日常模式）
echo     4. 查看持久化状态
echo     5. 检测出口 IP / 代理
echo     6. 目标环境启动 Claude Code（仅子进程）
echo     7. 目标环境启动 Claude Desktop（仅子进程）
echo     8. 打开可视化 Web 面板（GUI）
echo     0. 退出
echo.
echo   ========================================
echo.
set /p choice=  请输入选项编号 (0-8): 

if "%choice%"=="1" goto check
if "%choice%"=="2" goto persist_on
if "%choice%"=="3" goto persist_off
if "%choice%"=="4" goto status
if "%choice%"=="5" goto proxy
if "%choice%"=="6" goto run_claude
if "%choice%"=="7" goto run_desktop
if "%choice%"=="8" goto gui
if "%choice%"=="0" exit
echo.
echo   无效选项，请重新输入
timeout /t 2 >nul
goto menu

:check
echo.
echo   正在检测环境风险...
echo.
call cc-fix check
echo.
pause
goto menu

:persist_on
echo.
echo   正在开启安全环境...
echo.
call cc-fix persist on
echo.
pause
goto menu

:persist_off
echo.
echo   正在恢复原始环境...
echo.
call cc-fix persist off
echo.
pause
goto menu

:status
echo.
echo   当前持久化状态:
echo.
call cc-fix persist status
echo.
pause
goto menu

:proxy
echo.
echo   正在检测出口 IP...
echo.
call cc-fix proxy check
echo.
pause
goto menu

:run_claude
echo.
echo   以安全环境启动 Claude Code...
echo.
call cc-fix run claude
goto menu

:run_desktop
echo.
echo   以安全环境启动 Claude Desktop...
echo.
call cc-fix run --desktop
goto menu

:gui
echo.
echo   正在启动 Web 面板...
echo   浏览器将自动打开，按 Ctrl+C 退出
echo.
call cc-fix gui
goto menu
