@echo off
REM Reproducible build wrapper for a real Windows 11 Media Foundation virtual camera.
REM Requires: Visual Studio 2022 (C++ workload) + Windows SDK 10.0.22000+ + Windows 11 22000+.
REM This script CLONES Microsoft's official sample and builds it, then prints the manual
REM integration steps needed to stream VYRA Studio frames into it. It deliberately does NOT
REM contain a hand-typed MF source, because no machine that prepared this repo had MSVC or
REM the Windows 11 SDK headers to compile-verify such a source.

setlocal enabledelayedexpansion
set "THIS=%~dp0"

where git >nul 2>&1 || (echo [FAIL] git not found in PATH & exit /b 1)
where cl >nul 2>&1 || (
  echo [FAIL] MSVC 'cl.exe' not in PATH. Open a "Developer Command Prompt for VS 2022" first.
  exit /b 1
)

set "SAMPLE_ROOT=%THIS%Windows-Camera-sample"
if not exist "%SAMPLE_ROOT%\.git" (
  echo [INFO] Cloning microsoft/Windows-Camera official Virtual Camera sample...
  git clone --depth 1 https://github.com/microsoft/Windows-Camera.git "%SAMPLE_ROOT%" || exit /b 1
)

set "SLN=%SAMPLE_ROOT%\Samples\VirtualCamera\VirtualCamera.sln"
if not exist "%SLN%" (
  echo [FAIL] VirtualCamera.sln not found in %SAMPLE_ROOT%. Sample layout changed; check the repo.
  echo        https://github.com/microsoft/Windows-Camera/tree/master/Samples/VirtualCamera
  exit /b 1
)

msbuild "%SLN%" /m /p:Configuration=Release /p:Platform=x64 /restore || exit /b 1

echo.
echo [OK]  Sample built. Continue in an ELEVATED shell:
echo      regsvr32 /s "<path-to-built-src-dll>"
echo      mfvcam-host.exe Start     (see BUILD-VYRA-MF-VIRTUAL-CAMERA.md)
echo.
echo [NEXT]: Replace SimpleFrameGenerator with a reader of \\.\pipe\vyra_cam_frames produced
echo by vyra_cam_bridge.py so VYRA Studio video (not a test pattern) streams through the camera.
exit /b 0
