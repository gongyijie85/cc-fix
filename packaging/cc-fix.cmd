@echo off
setlocal
set "CC_FIX_NATIVE_HELPER=%~dp0..\native\cc-fix-native-helper.exe"
"%~dp0..\runtime\node.exe" "%~dp0..\core\index.js" %*
exit /b %ERRORLEVEL%
