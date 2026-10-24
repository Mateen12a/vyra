const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vyra.setupDone', '1'));
});

function fakeVideoFixture() {
  const width = 320, height = 180;
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`);
  const frames = [header];
  for (let n = 0; n < 8; n++) {
    const pixels = Buffer.alloc(width * height * 3 / 2);
    // BT.601 orange, plus a moving bright square. The corner stays orange for pixel checks.
    pixels.fill(140, 0, width * height);
    pixels.fill(78, width * height, width * height * 5 / 4);
    pixels.fill(198, width * height * 5 / 4);
    for (let y = 70; y < 100; y++) pixels.fill(230, y * width + 40 + n * 20, y * width + 70 + n * 20);
    frames.push(Buffer.from('FRAME\n'), pixels);
  }
  const filename = path.resolve('.data/browser-fixtures/extension-source.y4m');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, Buffer.concat(frames));
  return filename;
}

test('studio loads with the unpacked extension and relays video to another tab', async ({ baseURL }) => {
  test.setTimeout(60000);
  const extension = path.resolve('extension');
  const video = fakeVideoFixture();
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });
  try {
    // This fixture supplies its own stream below; disable Studio's independent output watchdog
    // so it cannot replace the test stream while testing extension transport and restart behavior.
    await context.addInitScript(origin => {
      if (location.origin === origin) {
        localStorage.setItem('vyra.vcamActive', '0');
        localStorage.setItem('vyra.setupDone', '1');
      }
    }, new URL(baseURL).origin);
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/api/auth/me', route => route.fulfill({ json: {
      user: { id: 'browser-check', email: 'check@example.test', role: 'user', verified: true }, balance: 600,
    } }));
    await context.route('**/api/live/token', route => route.abort());
    await context.route('**/api/live/status', route => route.fulfill({ json: {
      available: false, ai_label: true, can_remove_watermark: false,
    } }));
    const studio = await context.newPage();
    await studio.goto(`${baseURL}/app/studio`);
    await expect(studio.getByRole('button', { name: 'Turn on camera', exact: true })).toBeVisible();
    await expect.poll(() => studio.evaluate(() => Boolean(window.VyraVirtualCam))).toBe(true);
    await studio.getByRole('tab', { name: 'Virtual Cam', exact: true }).click();
    await expect(studio.getByTestId('vcam-panel').getByText('Extension ready', { exact: true })).toBeVisible();
    expect(await studio.evaluate(async () => (await navigator.mediaDevices.enumerateDevices())
      .some(device => device.deviceId === 'vyra-virtual-cam'))).toBe(false);

    // The UI-load assertion above covers React. Use a minimal authorized publisher for the
    // transport assertions so React's mount/unmount cleanup cannot stop the synthetic stream.
    const publisherURL = `${baseURL}/app/studio?extension-fixture=1`;
    await context.route(publisherURL, route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><html><head><title>Studio publisher fixture</title></head><body>Studio publisher</body></html>',
    }));
    await studio.goto(publisherURL);
    await expect.poll(() => studio.evaluate(() => typeof window.VyraVirtualCam?.publishStream)).toBe('function');

    const receiverURL = 'https://meet.google.com/vyra-extension-test';
    await context.route(receiverURL, route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Camera receiver</title><video autoplay muted></video>',
    }));
    const receiver = await context.newPage();
    await receiver.goto(receiverURL);
    // Select the device BEFORE Studio connects, as a real call can do.
    // Keep this exact stream: selecting it again would hide a stranded standby track.
    await receiver.evaluate(async () => {
      document.querySelector('video').srcObject = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: 'vyra-virtual-cam' } }, audio: false,
      });
      window.__selectedTrackId = document.querySelector('video').srcObject.getVideoTracks()[0].id;
    });
    // Native fake capture keeps producing frames when the publisher tab is hidden.
    await studio.evaluate(async () => {
      window.__extensionTestStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      window.VyraVirtualCam.publishStream(window.__extensionTestStream);
    });
    await expect.poll(() => receiver.evaluate(() => Boolean(
      window.VyraVirtualCam?.getState().remoteVideoTrack
    )), { timeout: 15000 }).toBe(true);
    // WebRTC may adapt the resolution; verify decoded content rather than a fixed size.
    await expect.poll(() => receiver.evaluate(() => document.querySelector('video').videoWidth)).toBeGreaterThan(0);
    const receivedColor = () => receiver.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(document.querySelector('video'), 0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    });
    await expect.poll(async () => {
      const pixel = await receivedColor();
      return {
        orange: pixel[0] > 200 && pixel[1] > 60 && pixel[1] < 150,
        pixel,
        connection: await receiver.evaluate(() => window.VyraVirtualCam.getState().pc?.connectionState),
      };
    }).toMatchObject({ orange: true });
    await studio.evaluate(() => {
      window.VyraVirtualCam.stop();
      window.__extensionTestStream.getTracks().forEach(track => track.stop());
    });
    await expect.poll(() => receiver.evaluate(() => window.VyraVirtualCam.getState().active)).toBe(false);
    await expect.poll(async () => {
      const pixel = await receivedColor();
      return pixel[0] > 200 && pixel[1] > 60 && pixel[1] < 150;
    }).toBe(false);
    await studio.evaluate(async () => {
      window.__extensionTestStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      window.VyraVirtualCam.publishStream(window.__extensionTestStream);
    });
    await expect.poll(async () => {
      const pixel = await receivedColor();
      return { orange: pixel[0] > 200 && pixel[1] > 60 && pixel[1] < 150, pixel };
    }, { timeout: 15000 }).toMatchObject({ orange: true });
    expect(await receiver.evaluate(() => document.querySelector('video').srcObject.getVideoTracks()[0].id))
      .toBe(await receiver.evaluate(() => window.__selectedTrackId));

    // Reported in a real call: the studio tab is reloaded and announces itself before it has video again. The
    // call must not stay on the standby card; it keeps asking and recovers once the studio's video starts.
    await studio.reload();
    await expect.poll(() => studio.evaluate(() => typeof window.VyraVirtualCam?.publishStream)).toBe('function');
    await studio.evaluate(() => window.postMessage({ source: 'vyra-studio-page-v2', payload: { type: 'vyra-cam:announce' } }, location.origin));
    await expect.poll(() => receiver.evaluate(() => window.VyraVirtualCam.getState().active)).toBe(true);
    await studio.waitForTimeout(3000);
    await studio.evaluate(async () => {
      window.__extensionTestStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      window.VyraVirtualCam.publishStream(window.__extensionTestStream);
    });
    await expect.poll(async () => {
      const pixel = await receivedColor();
      return { orange: pixel[0] > 200 && pixel[1] > 60 && pixel[1] < 150, pixel };
    }, { timeout: 15000 }).toMatchObject({ orange: true });
    expect(await receiver.evaluate(() => document.querySelector('video').srcObject.getVideoTracks()[0].id))
      .toBe(await receiver.evaluate(() => window.__selectedTrackId));
    expect(errors).toEqual([]);
  } catch (error) {
    for (const page of context.pages()) {
      console.log('Camera diagnostics', await page.evaluate(() => {
        const state = window.VyraVirtualCam?.getState();
        return {
          url: location.href, active: state?.active, requesting: state?.requesting,
          connection: state?.pc?.connectionState, signaling: state?.pc?.signalingState,
          track: state?.remoteVideoTrack?.readyState, muted: state?.remoteVideoTrack?.muted,
          videoReady: state?.remoteVideo?.readyState,
        };
      }).catch(() => ({})));
    }
    throw error;
  } finally {
    await context.close();
  }
});

test('a failed studio module shows recovery controls instead of a blank page', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ json: {
    user: { id: 'browser-check', email: 'check@example.test', role: 'user', verified: true }, balance: 600,
  } }));
  await page.route('**/ui/Studio-*.js', route => route.abort());
  await page.goto('/app/studio?mode=photo');
  await expect(page.getByRole('alert')).toContainText("VYRANI couldn't load this page");
  await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible();
});

for (const scenario of ['missing', 'outdated', 'throws', 'delayed']) {
  test(`studio stays usable with ${scenario} extension`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(scenario => {
      if (scenario === 'outdated') window.VyraVirtualCam = { stop() {} };
      if (scenario === 'throws') window.VyraVirtualCam = {
        publishStream() { throw new Error('Extension unavailable'); }, stop() {},
      };
    }, scenario);
    await page.route('**/api/auth/me', route => route.fulfill({ json: {
      user: { id: 'browser-check', email: 'check@example.test', role: 'user', verified: true }, balance: 600,
    } }));
    await page.route('**/api/live/token', route => route.abort());
    await page.goto('/app/studio?mode=photo');
    await expect(page.getByRole('button', { name: 'Turn on camera', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Virtual Cam', exact: true }).click();
    const panel = page.getByTestId('vcam-panel');
    await expect(panel).toBeVisible();
    const label = scenario === 'outdated' ? 'Update extension' : scenario === 'throws' ? 'Reload extension' : 'Install extension';
    await expect(panel.getByText(label, { exact: true })).toBeVisible();
    if (scenario === 'delayed') {
      await page.evaluate(() => {
        window.VyraVirtualCam = { publishStream() { window.__published = true; }, stop() {} };
      });
      await expect(panel.getByText('Extension ready', { exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.__published)).toBe(true);
    }
    await page.getByRole('button', { name: 'Turn on camera', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Go live', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: "VYRANI couldn't load this page" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
