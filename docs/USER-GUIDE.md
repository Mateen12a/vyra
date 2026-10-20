# Using Vyrani Studio

Testing address, once deployment is complete: https://vyrani.blackhevents.com/app/studio. The local app remains available at http://localhost:8765/app/studio.

New to Studio? Open **Setup guide** for the four-part animated tour: Camera, Your look, Go live, and Calls. Use **Next** or the numbered steps, pause the animation if you prefer, and choose **Skip for now** to enter Studio. You can reopen the tour any time. Watching it does not open your camera or use credits.

Use Chrome or Edge on Windows or Mac. Start with Google Meet for your first browser-call test. Safari and native desktop camera support are not ready for this setup.

## Open the studio

1. Open VYRANI and sign in.
2. Choose **Studio**. For this local Windows setup, use http://localhost:8765/app/studio.
3. Click **Turn on camera** and allow camera access. Pick your physical webcam if asked; do not choose VYRANI as the studio's input camera.
4. Add a character photo you have permission to use and confirm consent, or describe a look. Click **Use this look** where shown.
5. Click **Go live**. Wait until the preview shows your transformed video.

Live AI sessions use credits. Check your balance before starting. Photos using a person's likeness display an AI disclosure in normal operation.

## Choose picture quality

Use **Quality** below the preview:

- **Auto** starts at Sharp and can switch to Smooth after three consecutive reports of slow incoming video and an upload limit. It does not automatically switch back up, and waits at least a minute between automatic changes.
- **Smooth** uploads at a target of 960 × 540, 24 fps, up to 1.2 Mbps.
- **Sharp** uploads at a target of 1280 × 720, 30 fps, up to 2.5 Mbps. Selecting it manually prevents Auto from reducing it.

Your selection is saved. Quality changes keep the current session connected. The virtual camera can continue outputting a 1280 × 720 picture even when the upload is smaller.

While live, the row below the stage shows sending FPS, receiving FPS, round-trip network delay, and upload bitrate. A dash means the browser has not reported that measurement. Delay is not the full camera-to-display latency. The hint helps distinguish a slow upload from a slow AI response; neither these controls nor the readout guarantees smoother AI generations.

## Change the background

Background editing currently uses a text instruction, not a separate background-image picker.

1. In **Look**, enter a description such as: **Change the background to a bright modern office with large windows. Keep the person's face, hair, clothes and movement unchanged.**
2. Click **Use this look**, then **Go live** if you have not started yet. Check the studio preview before selecting it in a call.
3. Photo-based character prompts now explicitly preserve the original room, lighting, background, and camera framing. To request a different background, use a text-only look. The **Write** assistant creates a new text-only look and clears the photo.

This is a request to the live AI model. It can alter details or flicker; a clean, stable background replacement is not guaranteed. There is no dedicated blur or uploaded-background control yet.

## Set up browser calls once

1. In Studio, open **Virtual Cam** and download the browser extension ZIP.
2. Extract it to a permanent folder. On Mac, double-click the ZIP; on Windows, right-click it and choose **Extract All**.
3. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
4. Remove older VYRANI extension copies if any are installed.
5. Enable **Developer mode**, click **Load unpacked**, and select the extracted folder containing `manifest.json`.
6. Reload Studio and any calling tabs. The Virtual Cam panel should say **Extension ready**.

The unpacked setup is currently a manual installation step. You do not need Python, Xcode, or Visual Studio to load the browser extension on a computer that can already access VYRANI.

## Make a browser call

1. Keep Studio and the calling website in the **same browser profile**.
2. In Studio, enable **VYRANI Virtual Camera & Mic output**, start your physical camera, choose your look, and go live.
3. In another tab, open Google Meet and start a test meeting.
4. In Meet's camera settings, select **VYRANI AI Virtual Camera**.
5. Use your normal microphone for the first test. Test **VYRANI AI Virtual Microphone** separately after the video works.
6. Join from another device, or ask another participant to confirm they receive moving transformed video with the AI label.
7. Keep Studio open. Check that video continues when you switch to the calling tab.
8. End the call and stop your live VYRANI session when finished.

The extension targets Meet, WhatsApp Web, Zoom Web, Discord Web, and Teams Web. Compatibility must be checked in each service; a device appearing in its menu does not prove the other participant receives video. WhatsApp Web calling must also be available for your account/browser.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| **Update extension** | Download the latest ZIP, extract it, remove older VYRANI copies, and load the new folder. Reload both tabs. |
| **Reload extension** | Open the browser's extensions page and reload VYRANI, then reload Studio. If it persists, install the latest ZIP. |
| **Install extension** after installation | Check it is enabled in the same browser profile as Studio. Reload Studio. |
| Sign-in screen | Sign in using the same address you normally use. `localhost` and `127.0.0.1` have separate login sessions. |
| Page fails to load | Press **Ctrl + Shift + R** on Windows or **Command + Shift + R** on Mac. If it persists, copy the first red browser Console error. |
| Camera unavailable | Allow camera access in the browser and OS privacy settings. Select your physical webcam in Studio. |
| **Opening camera…** | Respond to the browser's camera permission prompt. If it is hidden, check the camera icon beside the address bar. |
| Camera startup error below the controls | Follow that message. If another app is using the camera, close it and retry. A slow device list should no longer prevent the acquired camera preview from appearing. |
| VYRANI missing from the calling app | Reload the calling tab after installing the extension. Use the website in Chrome or Edge, not the native desktop app. |
| Black, frozen, or standby video | Check that Studio itself has a moving preview and virtual-camera output is enabled. Reselect VYRANI in the calling website. |

## What has been verified

Automated Chromium checks cover the studio loading with the unpacked extension and test video reaching another tab. These checks do not prove a real Google Meet or WhatsApp call, paid AI transformation quality, Mac compatibility, or native desktop camera support. Confirm the real call on your own receiving device.
