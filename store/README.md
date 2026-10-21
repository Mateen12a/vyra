# Chrome Web Store submission: VYRANI AI Virtual Camera & Mic

Everything to paste into the Chrome Web Store Developer Dashboard (https://chrome.google.com/webstore/devconsole).
One-time developer registration fee: US$5. Review usually takes a few days, sometimes up to a few weeks.

**Before submitting:** fill in every highlighted placeholder on https://vyrani.com/privacy and https://vyrani.com/terms.
Reviewers open the privacy policy link.

## Package

Download the zip from the studio (Live → Virtual Cam → Download extension) or from
`https://vyrani.com/api/virtual-cam/extension.zip`. Upload that zip as the package. Version: **1.3.0**.

## Store listing

**Name:** VYRANI AI Virtual Camera & Mic

**Summary (132 characters max, from the manifest):**
Use your VYRANI live AI look as a camera and mic in Google Meet, WhatsApp Web, Zoom, Discord and Teams on the web.

**Category:** Communication (alternative: Tools)

**Language:** English

**Description:**

Turn your webcam into anyone in your video calls.

VYRANI changes your camera video live with AI. Type a look ("in a charcoal blazer", "a brighter room") or add one
photo to become a different person, and your face, expressions and movement drive the new look in real time. This
extension brings that live result into your calls as a camera and microphone you can pick.

How it works
1. Open the VYRANI studio at vyrani.com and go live with a look.
2. In your call, open camera settings and choose "VYRANI AI Virtual Camera" (and "VYRANI AI Virtual Microphone" if you
   use a VYRANI voice).
3. Keep the studio tab open. Switch looks any time; the call follows.

Works in Chrome on Mac and Windows with:
• Google Meet
• WhatsApp Web
• Zoom (web)
• Discord (web)
• Microsoft Teams (web)

Made with consent, marked as AI
Use your own face and voice, an AI-made person, or someone who has agreed. VYRANI marks its video as AI-made and can
show a visible VYRANI label. If your credits or the connection run out mid-call, your call shows a "Be right back"
card instead of switching to your real camera.

Private by design
The extension passes video between your own browser tabs only. It sends no data to VYRANI or anyone else and doesn't
read the pages you visit.

A VYRANI account is needed for live AI looks. Live time uses VYRANI credits; new accounts can try it free.

**Graphics (in this folder):**
- Store icon 128×128: `icon-128.png`
- Screenshots 1280×800: `screenshot-1-calls.png`, `screenshot-2-camera.png`, `screenshot-3-looks.png`, `screenshot-4-safety.png`
- Small promo tile 440×280: `promo-small-440x280.png`

**Official URL / homepage:** https://vyrani.com
**Support URL:** https://vyrani.com/terms (or a support email page once you have one)

## Privacy practices tab

**Single purpose:**
Lets users select the live video and audio from their own VYRANI studio tab as a camera and microphone in supported
web-based video calling sites.

**Permission justifications:**
- `storage`: Saves two of the user's extension settings locally in the browser (which VYRANI studio address to trust,
  and a compatibility switch). No personal data is stored.
- Host permissions (vyrani.com, meet.google.com, web.whatsapp.com, *.zoom.us, discord.com, teams.microsoft.com,
  teams.live.com, localhost): The extension must run on the VYRANI studio page to read its live output, and on these
  calling sites to offer that output as a camera and microphone choice. It runs on no other sites. localhost is used
  only when a user runs the VYRANI studio on their own computer.

**Remote code:** No, I am not using remote code. (All code is in the package.)

**Data usage, what the extension collects:** tick **none** of the categories. The extension does not collect or
transmit personally identifiable information, health, financial, authentication, personal communications, location,
web history, user activity or website content. Video and audio move only between the user's own tabs inside their
browser.

**Certify all three:**
- I do not sell or transfer user data to third parties, apart from the approved use cases.
- I do not use or transfer user data for purposes unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://vyrani.com/privacy

## Distribution

- Visibility: **Public** (or **Unlisted** first, so only people with the link can install it while you test).
- Regions: all regions you sell in.

## After approval

Send me the extension's store link. I'll replace the "Download extension / Load unpacked" steps in the studio and the
setup tour with a one-click "Add to Chrome" button.
