# One-time bootstrap for a fresh Windows machine: venv + dependencies + .env + frontend + server.
# Run from the project directory:  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
param([int]$Port = 8765)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project

Write-Host "VYRA AI — setting up in $project"

# 1. Python
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw 'Python 3.9+ is not on PATH. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH") and run this again.'
}
Write-Host "Using $(python --version)"

# 2. Virtual environment + backend dependencies
if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    Write-Host 'Creating the virtual environment (.venv)...'
    python -m venv .venv
}
& .venv\Scripts\python.exe -m pip install --quiet --upgrade pip
& .venv\Scripts\python.exe -m pip install --quiet -e .
if ($LASTEXITCODE -ne 0) { throw 'Backend dependencies failed to install. Check the messages above.' }

# 3. Local settings (.env). Leave FAL_KEY empty to explore only — the Setup Wizard in the app checks it.
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Host 'Created .env from .env.example.'
}

# 4. Frontend (only built when the prebuilt bundle is not in the tree)
if (-not (Test-Path -LiteralPath 'person_studio/web/dist/index.html')) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'The built frontend was not found and npm is not on PATH. Install Node.js LTS from https://nodejs.org and run this again.'
    }
    Write-Host 'Building the frontend (first run only)...'
    npm --prefix frontend ci
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependencies failed to install. Check the messages above.' }
    npm --prefix frontend run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed. Check the messages above.' }
}

# 5. Start the server and open the Setup Wizard
& (Join-Path $PSScriptRoot 'start-local.ps1') -Port $Port -OpenBrowser
Write-Host 'The Setup Wizard opens with the studio. Run scripts\start-local.ps1 from now on.'
