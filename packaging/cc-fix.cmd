@echo off
setlocal
"%~dp0..\runtime\node.exe" "%~dp0..\core\index.js" %*
exit /b %ERRORLEVEL%
