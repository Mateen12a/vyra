const { test, expect } = require('@playwright/test');

const setup = { mode: 'hosted', steps: [
  { id: 'engine', title: 'AI engine', status: 'done', detail: 'Handled by VYRA.' },
  { id: 'extension', title: 'Browser virtual camera', status: 'guide', detail: 'Adds VYRA to supported websites.' },
] };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('vyra.setupDone');
    localStorage.setItem('vyra.voice', 'off');
    localStorage.setItem('vyra.vcamActive', '0');
    window.__cameraRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__cameraRequests++; throw new Error('Tour should not request camera'); };
  });
  await page.route('**/api/auth/me', route => route.fulfill({ json: {
    user: { id: 'tour-test', email: 'tour@example.test', role: 'user', verified: true }, balance: 600,
  } }));
  await page.route('**/api/live/status', route => route.fulfill({ json: { available: false, provider: 'fal', ai_label: true } }));
  await page.route('**/api/setup', route => route.fulfill({ json: setup }));
  await page.route(/decart\.ai|fal\.(run|ai)/, route => route.abort());
  await page.routeWebSocket(/fal|decart/, socket => socket.close());
});

test('four animated chapters explain the workflow without opening a camera or spending credits', async ({ page }) => {
  let tokens = 0;
  page.on('request', r => { if (r.url().includes('/api/live/token')) tokens++; });
  await page.goto('/app/studio');
  const tour = page.getByTestId('studio-tour');
  await expect(tour.getByRole('heading', { name: 'Start with you.' })).toBeVisible();
  await tour.getByRole('button', { name: 'Pause motion' }).click();
  await expect(tour.locator('.tour-person').first()).toHaveCSS('animation-play-state', 'paused');
  await tour.getByRole('button', { name: 'Play motion' }).click();
  await tour.getByRole('button', { name: 'Next: choose a look' }).click();
  await expect(tour.getByRole('heading', { name: 'Make it your own.' })).toBeFocused();
  await tour.getByRole('button', { name: 'Next: go live' }).click();
  await expect(tour.getByText('Live transformations use credits.', { exact: false })).toBeVisible();
  await tour.getByRole('button', { name: 'Next: use it in a call' }).click();
  await expect(tour.getByRole('button', { name: 'Open studio', exact: true })).toBeEnabled();
  await expect(tour.getByText(/Until the store release/)).toBeVisible();
  expect(await page.evaluate(() => window.__cameraRequests)).toBe(0);
  expect(tokens).toBe(0);
  await tour.getByRole('button', { name: 'Open studio', exact: true }).click();
  await expect(tour).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('vyra.setupDone'))).toBe('1');
  await page.getByRole('button', { name: 'Setup guide', exact: true }).click();
  await expect(tour.getByRole('heading', { name: 'Start with you.' })).toBeVisible();
});

test('failed readiness stays unconfirmed and retry recovers', async ({ page }) => {
  let fail = true;
  await page.route('**/api/setup', route => fail
    ? route.fulfill({ status: 500, json: { detail: 'Setup temporarily unavailable' } })
    : route.fulfill({ json: setup }));
  await page.goto('/app/studio');
  const tour = page.getByTestId('studio-tour');
  await tour.getByRole('button', { name: /04.*Calls/ }).click();
  await expect(tour.getByRole('alert')).toContainText('Setup temporarily unavailable');
  await expect(tour.getByRole('button', { name: 'Open studio', exact: true })).toBeDisabled();
  fail = false;
  await tour.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(tour.getByRole('button', { name: 'Open studio', exact: true })).toBeEnabled();
  await expect(tour.getByRole('alert')).toHaveCount(0);
});

test('missing engine remains a blocker and malformed responses do not claim readiness', async ({ page }) => {
  let body = { mode: 'local', steps: [{ id: 'engine', title: 'AI engine', status: 'missing', detail: 'Add FAL_KEY and restart.' }] };
  await page.route('**/api/setup', route => route.fulfill({ json: body }));
  await page.goto('/app/studio');
  const tour = page.getByTestId('studio-tour');
  await tour.getByRole('button', { name: /04.*Calls/ }).click();
  await expect(tour.getByText('Add FAL_KEY and restart.')).toBeVisible();
  await expect(tour.getByRole('button', { name: 'Open studio', exact: true })).toBeDisabled();
  body = { mode: 'local', steps: [] };
  await tour.getByRole('button', { name: 'Check setup again' }).click();
  await expect(tour.getByRole('alert')).toContainText('incomplete');
  await expect(tour.getByRole('button', { name: 'Open studio', exact: true })).toBeDisabled();
});

test('extension detected after opening the tour updates the readiness display', async ({ page }) => {
  await page.goto('/app/studio');
  const tour = page.getByTestId('studio-tour');
  await tour.getByRole('button', { name: /04.*Calls/ }).click();
  await expect(tour.getByRole('link', { name: 'Download extension' })).toBeVisible();
  await page.evaluate(() => { window.VyraVirtualCam = { publishStream() {}, stop() {} }; });
  await expect(tour.getByText('Detected in this browser')).toBeVisible({ timeout: 10000 });
  await expect(tour.getByRole('link', { name: 'Download extension' })).toHaveCount(0);
});

test('desktop path explains the OBS dependency and hosted limitation', async ({ page }) => {
  await page.goto('/app/studio');
  const tour = page.getByTestId('studio-tour');
  await tour.getByRole('button', { name: /04.*Calls/ }).click();
  await tour.getByRole('button', { name: 'Desktop apps', exact: true }).click();
  await expect(tour.getByText(/A hosted VYRA website cannot launch OBS/)).toBeVisible();
  await expect(tour.getByRole('link', { name: 'Download extension' })).toHaveCount(0);
});

test('mobile tour fits, respects reduced motion, and keeps keyboard focus in the dialog', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/app/studio');
  const tour = page.getByTestId('studio-tour');
  await expect(tour.getByRole('heading', { name: 'Start with you.' })).toBeVisible();
  await expect(tour.locator('.tour-person').first()).toHaveCSS('animation-name', 'none');
  await expect(tour.getByRole('button', { name: 'Pause motion' })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('tour-mobile.png') });
  await tour.getByRole('button', { name: 'Next: choose a look' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tour).toHaveCount(0);
});
