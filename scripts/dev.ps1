# Local development: starts the Stripe webhook forwarder (test mode) and the VYRANI server on port 8765.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$stripe = "$env:USERPROFILE\tools\stripe\stripe.exe"
$key = (Select-String -Path .env -Pattern '^STRIPE_SECRET_TEST_KEY=(.*)$').Matches.Groups[1].Value.Trim('"')

$forwarder = $null
if ((Test-Path $stripe) -and $key) {
    $forwarder = Start-Process -FilePath $stripe -NoNewWindow -PassThru -RedirectStandardOutput .data\stripe.log -RedirectStandardError .data\stripe.err `
        -ArgumentList "listen", "--api-key", $key, "--events", "checkout.session.completed,checkout.session.async_payment_succeeded", `
        "--forward-to", "http://127.0.0.1:8765/api/billing/webhook"
    Write-Host "Stripe webhooks forwarding to the local server (log: .data\stripe.log)"
} else {
    Write-Host "Stripe CLI or STRIPE_SECRET_TEST_KEY missing; purchases won't add credits locally."
}
Write-Host "VYRANI: http://127.0.0.1:8765   admin panel: http://127.0.0.1:8765/admin"
try { & .venv\Scripts\python.exe -m person_studio }
finally { if ($forwarder) { Stop-Process -Id $forwarder.Id -Force -ErrorAction SilentlyContinue } }
