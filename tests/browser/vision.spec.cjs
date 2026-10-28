// Backgrounds, face tips and the top-up prompt. The live service is faked (no fal calls, no credits); the camera
// is Chromium's fake device, which shows a test pattern and no face.
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('vyra.setupDone', '1');
    localStorage.setItem('vyra.voice', 'off');
    localStorage.setItem('vyra.vcamActive', '0');
  });
  await page.route(/decart\.ai|fal\.(run|ai)/, route => route.abort());
  await page.routeWebSocket(/fal|decart|fake\.invalid/, socket => socket.close());
  await page.route('**/api/live/status', route => route.fulfill({ json: {
    available: true, provider: 'fal', model: 'test-model', ai_label: true, max_session_seconds: 300,
  } }));
  await page.route('**/api/live/token', route => route.fulfill({ json: { token: 'a.b.c', url: 'wss://fake.invalid', provider: 'fal' } }));
  await page.route('**/api/assist/**', route => route.abort());
  await page.route('**/assets/fal-live.js', route => route.fulfill({ contentType: 'application/javascript', body: `
    window.FalLucy = { connect: async (stream, opts) => {
      window.__sent = stream.getVideoTracks()[0];
      window.__replaced = [];
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      const timer = setInterval(() => { ctx.fillStyle = '#ff6b2b'; ctx.fillRect(0, 0, 640, 360); }, 33);
      const remote = canvas.captureStream(30);
      opts.onRemoteStream(remote);
      return {
        on() { return this; }, set: async () => {}, setVideoQuality: async () => {},
        replaceVideoTrack: async track => { window.__replaced.push(track); window.__sent = track; },
        disconnect() { clearInterval(timer); remote.getTracks().forEach(t => t.stop()); },
      };
    } };`,
  }));
});

const me = balance => ({ json: { user: { id: 'vision-check', email: 'vision@example.test', role: 'user', verified: true, consented: true }, balance } });

async function camera(page) {
  await page.goto('/app/studio');
  await page.getByRole('button', { name: 'Turn on camera', exact: true }).click();
  await expect.poll(() => page.locator('video.stage-cam').evaluate(v => v.videoWidth), { timeout: 15000 }).toBeGreaterThan(0);
}

test('the face check says when no face is in view', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill(me(600)));
  await camera(page);
  await expect(page.getByTestId('face-tip')).toContainText("We can't see a face", { timeout: 20000 });
});

test('a background is drawn on this device and is what the live session receives', async ({ page }) => {
  test.setTimeout(90000); // the cut-out model loads on first use
  await page.route('**/api/auth/me', route => route.fulfill(me(600)));
  await camera(page);
  const group = page.getByRole('group', { name: 'Background' });
  await group.getByRole('button', { name: 'Blur', exact: true }).click();
  await expect(group.getByRole('button', { name: 'Blur', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 20000 });
  const preview = page.locator('video.stage-bgview');
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(v => v.videoWidth), { timeout: 15000 }).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Interview ready', exact: true }).click();
  await page.getByRole('button', { name: 'Use this look', exact: true }).click();
  await page.getByRole('button', { name: 'Go live', exact: true }).click();
  await expect(page.getByRole('button', { name: 'End', exact: true })).toBeVisible({ timeout: 15000 });
  const camTrack = () => document.querySelector('video.stage-cam').srcObject.getVideoTracks()[0].id;
  expect(await page.evaluate(camTrack)).not.toBe(await page.evaluate(() => window.__sent.id)); // the background track, not the raw camera

  // Switching back to None while live swaps the raw camera in without reconnecting.
  await group.getByRole('button', { name: 'None', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__replaced.length)).toBe(1);
  expect(await page.evaluate(camTrack)).toBe(await page.evaluate(() => window.__sent.id));
});

test('going live without enough credit opens the top-up prompt with packs', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill(me(10)));
  await page.route('**/api/pricing', route => route.fulfill({ json: {
    credit_usd: 0.1, live_credits_per_minute: 60, tools: {},
    packs: [
      { id: 'starter', name: 'Starter', credits: 240, amount_cents: 2400 },
      { id: 'p50', name: 'Short', credits: 540, amount_cents: 5000 },
      { id: 'creator', name: 'Creator', credits: 1260, amount_cents: 11000 },
    ],
  } }));
  await camera(page);
  await page.getByRole('button', { name: 'Interview ready', exact: true }).click();
  await page.getByRole('button', { name: 'Use this look', exact: true }).click();
  await page.getByRole('button', { name: 'Go live', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Top up to go live' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.topup-pack')).toHaveCount(3);
  await expect(dialog.locator('.topup-pack.best')).toContainText('$50');
  await expect(dialog).toContainText('Most popular');
});
