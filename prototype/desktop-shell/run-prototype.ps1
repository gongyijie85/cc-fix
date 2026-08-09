$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $prototypeRoot 'build-prototype.ps1')
Start-Process -FilePath (Join-Path $prototypeRoot 'build\portable\CC-Fix-Desktop-Prototype.exe')
