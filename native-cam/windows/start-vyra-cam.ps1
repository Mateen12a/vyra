# Starts the VYRA Native Virtual Camera bridge on Windows and registers the per-user camera (no admin needed).
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$bridge = Join-Path $root "bridge\vyra_cam_bridge.py"

Write-Host "Starting VYRA AI Virtual Camera local bridge on ws://127.0.0.1:29876/vyra-cam ..." -ForegroundColor Cyan
$dll = Join-Path $here "VyraDirectShowCam.dll"
if (Test-Path $dll) {
    regsvr32.exe /s $dll
    Write-Host "Registered 'VYRA AI Camera' in current user profile (HKCU)." -ForegroundColor Green
}

python $bridge
