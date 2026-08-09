@echo off
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo Visual Studio Build Tools not found. 1>&2
  exit /b 2
)
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
if not defined VSINSTALL (
  echo Visual C++ x64 tools not found. 1>&2
  exit /b 3
)
call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b %errorlevel%
cargo build --manifest-path "%~dp0src-tauri\Cargo.toml" --release
exit /b %errorlevel%
