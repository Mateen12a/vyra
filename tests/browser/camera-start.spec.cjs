const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ json: {
    user: { id: 'camera-check', email: 'check@example.test', role: 'user', verified: true }, balance: 600,
  } }));
  await page.route('**/api/live/status', route => route.fulfill({ json: { available: false, ai_label: true } }));
  await page.route('**/api/live/token', route => route.abort());
});

for (const mode of ['hangs', 'rejects']) {
  test(`camera preview starts even when device enumeration ${mode}`, async ({ page }) => {
    await page.addInitScript(mode => {
      navigator.mediaDevices.enumerateDevices = () => mode === 'hangs'
        ? new Promise(() => {}) : Promise.reject(new Error('Device list unavailable'));
    }, mode);
    await page.goto('/app/studio');
    await page.getByRole('button', { name: 'Turn on camera', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Turn on your camera' })).toHaveCount(0);
    await expect.poll(() => page.locator('video.stage-cam').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
  });
}

test('camera permission failures explain recovery next to the camera button', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await page.goto('/app/studio');
  await page.getByRole('button', { name: 'Turn on camera', exact: true }).click();
  await expect(page.getByTestId('source-error')).toContainText('Allow it');
  await expect(page.getByRole('button', { name: 'Turn on camera', exact: true })).toBeEnabled();
});

test('pending camera permission shows a waiting state', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
  });
  await page.goto('/app/studio');
  await page.getByRole('button', { name: 'Turn on camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Opening camera…', exact: true })).toBeDisabled();
  await expect(page.getByText('Allow camera access in your browser if prompted.', { exact: true })).toBeVisible();
});

test('starting live and updating the credit balance keeps the camera and session open', async ({ page }) => {
  const ended = [];
  await page.route('**/api/live/status', route => route.fulfill({ json: {
    available: true, provider: 'fal', model: 'test-model', ai_label: true, max_session_seconds: 300,
    providers: [{ id: 'fal', name: 'fal', available: true }],
  } }));
  await page.route('**/api/live/token', route => ended.length
    ? route.fulfill({ status: 409, json: { detail: 'This live session has ended. Start a new one.' } })
    : route.fulfill({ json: {
      token: 'a.b.c', url: 'wss://fal.test/lucy', provider: 'fal', meter: { session_id: 'test-meter', balance: 540 },
    } }));
  await page.route('**/api/live/meter/*/end', route => {
    ended.push(route.request().url());
    return route.fulfill({ json: { balance: 540 } });
  });
  await page.route('**/assets/voice.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  // Stand-in for the fal live client (fal is the only engine): records the input and stays connected.
  await page.route('**/assets/fal-live.js', route => route.fulfill({
    contentType: 'application/javascript', body: `
      window.FalLucy = { connect: async (stream) => {
        window.__liveInput = stream.getVideoTracks()[0];
        await new Promise(resolve => setTimeout(resolve, 100));
        window.__liveConnected = true;
        return { on() { return this; }, set: async () => {}, replaceVideoTrack: async () => {},
          disconnect() { window.__liveDisconnected = true; } };
      } };`,
  }));
  await page.goto('/app/studio');
  await page.getByRole('button', { name: 'Turn on camera', exact: true }).click();
  await expect.poll(() => page.locator('video.stage-cam').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Astronaut', exact: true }).click();
  await page.getByRole('button', { name: 'Use this look', exact: true }).click();
  await page.getByRole('button', { name: 'Go live', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__liveConnected)).toBe(true);
  await expect(page.getByText('540 left · 9 min', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__liveInput.readyState)).toBe('live');
  expect(await page.evaluate(() => Boolean(window.__liveDisconnected))).toBe(false);
  expect(ended).toEqual([]);
  await page.waitForTimeout(1300); // presses within 1.2 s of Go live are treated as a double-click and ignored
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(() => ended.length).toBe(1);
  expect(await page.evaluate(() => window.__liveInput.readyState)).toBe('live');
});
