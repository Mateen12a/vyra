param([int]$Port = 8765, [switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $project '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw 'Install the local environment using the commands in README.md first.'
}
$url = "http://127.0.0.1:$Port"
$alreadyRunning = $false
try {
    $status = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2
    $alreadyRunning = $status.version -eq '0.1.0' -and $status.mode -eq 'clip'
} catch { }
if (-not $alreadyRunning) {
    $runtime = Join-Path $project '.data'
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    $process = Start-Process -FilePath $pythonPath -ArgumentList @('-m', 'person_studio', '--port', "$Port") -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'server.stdout.log') -RedirectStandardError (Join-Path $runtime 'server.stderr.log')
    Set-Content -LiteralPath (Join-Path $runtime 'localserver.pid') -Value $process.Id
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 300
        if ($process.HasExited) { throw 'The server stopped during startup. Check .data/server.stderr.log.' }
        try {
            $status = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2
            if ($status.version -eq '0.1.0') { $alreadyRunning = $true; break }
        } catch { }
    }
    if (-not $alreadyRunning) { throw 'The server did not become ready. Check .data/server.stderr.log.' }
}
Write-Output "VYRANI AI is ready at $url"
if ($OpenBrowser) { Start-Process -FilePath $url }
