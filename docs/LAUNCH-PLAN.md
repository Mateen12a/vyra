# First-user experience, naming and deployment

Prepared 19 October 2026. This is a launch plan, not a claim that VYRANI is production-ready.

## Animated studio tour

The first-run tour now explains four actions, one per chapter:

1. Camera: give permission and choose a physical webcam.
2. Look: describe a look or upload a consented reference photo.
3. Go live: understand the preview and that live use consumes credits.
4. Calls: choose the browser-extension path or learn the separate OBS desktop path.

The illustrations use local CSS motion. They do not access the camera, mint live tokens, or spend credits. Motion can be paused and respects reduced-motion preferences. Users can skip and reopen the tour from **Setup guide**. Readiness is checked against the server; errors allow retry and never count as success. Extension detection updates while the tour is open.

## Brand and testing address (decided 20 October 2026)

- Brand: **Vyrani**. Web application: **Vyrani Studio**.
- Testing address: **https://vyrani.blackhevents.com**. The user is preparing DNS; HTTPS and deployment still need verification.
- Future preferred domain: `vyrani.com`, pending purchase and confirmation. It is not trusted by the extension before ownership is confirmed.
- Existing AI video editor https://www.usevyra.com/ uses the previous name Vyra; this is the reason for choosing a distinct brand.
- Existing database names, environment variables prefixed `VYRA_`, browser preference keys, internal media IDs and extension message names remain compatible. New public URL setting: `VYRANI_PUBLIC_URL`, with `VYRA_PUBLIC_URL` retained as a fallback. Renaming the UI does not migrate or discard account data.

Testing DNS: create an **A** record named **vyrani** in the `blackhevents.com` zone, pointing to **132.145.49.60**. This points at the existing server; it does not complete Nginx routing, HTTPS, or application deployment by itself. The existing Black Heritage site must keep its own Nginx configuration and application service.

## Deployment for a browser-first beta

1. **Fix the known blockers.** Repair OBS collection serialization and JSON handling; keep unfinished native installers out of the consumer installation flow. Validate the animated tour on Windows and Mac. See the prior source review for native build gaps.
2. **Choose the final domain.** Configure DNS, HTTPS, `VYRANI_PUBLIC_URL`, and `PERSON_ALLOWED_ORIGINS`. Update extension manifest matches, host permissions, producer allowlists, and public-facing support/email addresses to the new domain. Changing the server URL alone does not allow the extension to run there.
3. **Deploy the complete app to the existing Oracle blackhevents instance.** Build the React frontend and run the Python/FastAPI server on an always-on host that supports WebSockets. A static frontend upload is insufficient. Render documents a FastAPI deployment path: https://render.com/docs/deploy-fastapi . Start with one application instance: jobs and some runtime state are process-local today. Configure the reverse proxy's timeouts and upload limits for the supported recording/streaming workloads.
4. **Set the public hostname.** The backend now includes the hostname from `VYRANI_PUBLIC_URL` in its trusted-host allowlist while retaining local development hosts. Configure `VYRANI_PUBLIC_URL=https://vyrani.blackhevents.com` and `PERSON_ALLOWED_ORIGINS=https://vyrani.blackhevents.com` on the server. Keep real account authentication enabled through `MONGO_URI`.
5. **Configure accounts and storage.** Set `MONGO_URI` to a replica-set deployment, set database backups, and use persistent storage for `.data` and job artifacts. Host filesystem persistence must be configured separately; see https://render.com/docs/disks . Define retention/deletion rules before storing customer media.
6. **Configure server secrets.** Keep `FAL_KEY`, payment keys, OAuth secrets and SMTP credentials on the server. Use staging credentials during checkout/refund testing. Confirm provider commercial terms, session limits and costs for the intended customer offering. The current fal-backed live mode does not require buying a dedicated GPU server.
7. **Configure actual email delivery.** Set SMTP host, port, user, password and sender. Test verification and password reset from a fresh account. Without SMTP, the current fallback logs links rather than delivering email.
8. **Configure checkout if charging.** Set Stripe keys and webhook secret, production return URLs and optional Google OAuth redirect URI. Test duplicate webhooks, credit balances, early disconnects and refunds before enabling live payments. Confirm the payment provider supports the operating company's country.
9. **Publish the browser extension.** Prepare icons/screenshots, privacy and data-use disclosures, installation help and a Chrome Web Store developer account. Submit for review: https://developer.chrome.com/docs/webstore/publish/ . Approval is separate from deploying the website.
10. **Prove the first complete customer journey.** New account → verification → credits → camera → consented look → live preview → recording → extension → real Meet/WhatsApp Web call. Test on physical Windows and Mac devices and verify what the remote participant receives. Add error monitoring, billing reconciliation, spending alerts and a rollback procedure before inviting paying users.

## Separate desktop milestone

OBS is the practical interim desktop route, subject to application and OS-version testing. A hosted site cannot launch OBS on the customer's computer through server-side Python. That needs manual OBS setup or an installed local companion with an authenticated communication path.

The Windows Media Foundation script currently builds an upstream sample and leaves VYRANI frame integration as a manual next step. The Mac preview still needs corrected Swift source, a real Mac build, frame-feed integration, signing/installation validation and application testing. Neither should be marketed as a finished native VYRANI camera.

## Recommended order

Fix readiness and live-call failures → choose and register the name → deploy a private browser beta → publish the extension → validate the OBS workflow → finish native companions.
