# Vyrani testing deployment

Deployed 20 October 2026 to **https://vyrani.blackhevents.com** on the existing Oracle ARM Ubuntu server, `132.145.49.60`.

## Installed layout

- Application release: `/opt/vyrani/releases/770d5d5`; `/opt/vyrani/current` points to this release.
- Python environment: `/opt/vyrani/venv`.
- Process: `vyrani.service`, running as the dedicated `vyrani` system user on **127.0.0.1:8765**.
- Private operator configuration: `/etc/vyrani/vyrani.env`, root-owned, mode 0600. Never commit it.
- Persistent data: `/var/lib/vyrani`, owned by the service user.
- Nginx: `/etc/nginx/sites-available/vyrani`, enabled by a symlink in `sites-enabled`.
- The existing Cloudflare origin certificate covers `*.blackhevents.com`. Its private key stays on the server. Cloudflare should use **Full (strict)** TLS. Browsers connect through Cloudflare's publicly trusted edge certificate.

The deployment uses the existing configured MongoDB database so existing accounts can sign in. Database names and browser preference identifiers remain compatible with the previous brand. Only the fal key, MongoDB settings, model selection and explicit deployment settings were transferred. Stripe/payment keys were excluded. SMTP is not configured.

The service has a 75% CPU quota, 1 GB memory soft limit and 1.5 GB memory hard limit. These are initial isolation settings for sharing the server, not a measured concurrency guarantee. The original Black Heritage Nginx file was verified unchanged, and its HTTP site still returned 200 after deployment.

## Runtime assets

The committed frontend build is served from the application release. On the server, `npm ci` and `npm run build:media`, `npm run build:vision`, and `npm run build:live-sdk` built the ignored browser SDK assets. FFmpeg and Python venv support were installed through Ubuntu packages. No GPU server was provisioned.

## Operations

```sh
sudo systemctl status vyrani
sudo systemctl restart vyrani
sudo journalctl -u vyrani --since '10 minutes ago'
sudo nginx -t
```

Treat logs as private: the current fallback mailer records verification/reset links when SMTP is absent. Never paste raw logs containing those links into public reports.

For an update, archive the tested Git commit into a new release directory, install any changed dependencies/build required browser assets, make non-secret release files readable by the service user, update the `current` symlink, restart **only** `vyrani`, and verify the public page and APIs. Retain the previous release until validation passes. Secrets and persistent media stay outside release directories.

Rollback an application update by restoring the previous `current` symlink and restarting `vyrani`. To remove the testing website route, disable only `/etc/nginx/sites-enabled/vyrani`, run `nginx -t`, and reload Nginx. Do not replace the existing Black Heritage configuration.

## Verified and remaining checks

Verified: database connectivity and replica-set support; two existing verified accounts; active service without restarts; public HTTPS sign-in page returns 200, has the Vyrani title, runs in a secure browser context and emits no JavaScript errors; unauthenticated account API returns 401. No paid live token was requested during the sign-in browser check.

The existing Playwright extension handoff test also passed with `VYRA_URL=https://vyrani.blackhevents.com`: the unpacked extension loaded the hosted Studio, excluded its own virtual device as a Studio input, and delivered a synthetic video stream to an intercepted calling-page fixture, including stop/restart with the same selected receiver track. This used mocked account/live-status responses and a receiver fixture; it does not prove a real Meet/WhatsApp call or a paid AI transformation.

Still required: a user signs in with their actual account, starts and ends a short paid AI session, checks recording, then verifies what a remote participant receives in an actual Meet/WhatsApp Web call. Email verification/password reset delivery and real payments are not ready. Native desktop-camera installers remain unfinished.
