$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $project '.data/localserver.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No launcher-managed local server was found.'; return }
$serverProcessId = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim())
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId"
if ($process) {
    $expectedPython = (Resolve-Path -LiteralPath (Join-Path $project '.venv/Scripts/python.exe')).Path
    if ($process.ExecutablePath -ne $expectedPython -or $process.CommandLine -notmatch '-m\s+person_studio') {
        throw 'The saved PID does not belong to this project server. No process was stopped.'
    }
    # Windows virtualenv Python launches the base interpreter as a child process.
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $serverProcessId"
    foreach ($child in $children) {
        if ($child.CommandLine -match '-m\s+person_studio') {
            Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
        }
    }
    Stop-Process -Id $serverProcessId -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $pidFile
Write-Output 'VYRA AI stopped.'
