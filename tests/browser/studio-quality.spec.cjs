const { test, expect } = require('@playwright/test');
const { buildSync } = require('esbuild');
const vm = require('vm');
const fs = require('fs');

const slowUpload = { receiveFps: 8, sendFps: 10, rttMs: 250, sendKbps: 900 };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('vyra.voice', 'off');
    localStorage.setItem('vyra.vcamActive', '0');
  });
  await page.route(/decart\.ai|fal\.(run|ai)/, route => route.abort());
  await page.routeWebSocket(/fal|decart|fake\.invalid/, socket => socket.close());
  await page.route('**/api/auth/me', route => route.fulfill({ json: {
    user: { id: 'quality-check', email: 'quality@example.test', role: 'user', verified: true }, balance: 600,
  } }));
  await page.route('**/api/live/status', route => route.fulfill({ json: {
    available: true, provider: 'fal', model: 'test-model', ai_label: true, max_session_seconds: 300,
  } }));
  await page.route('**/api/live/token', route => route.fulfill({ json: {
    token: 'a.b.c', url: 'wss://fake.invalid', provider: 'fal',
  } }));
  await page.route('**/api/assist/**', route => route.abort());
  await page.route('**/assets/fal-live.js', route => route.fulfill({ contentType: 'application/javascript', body: `
    window.__qualityCalls = [];
    window.__connectCalls = 0;
    window.FalLucy = { connect: async (stream, opts) => {
      window.__connectCalls++;
      window.__qualityInput = stream.getVideoTracks()[0];
      const handlers = {};
      window.__emitQuality = metrics => (handlers.connectionQuality || []).forEach(fn => fn({ metrics }));
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      const draw = () => { ctx.fillStyle = '#ff6b2b'; ctx.fillRect(0, 0, 640, 360); };
      draw();
      const remote = canvas.captureStream(30);
      const timer = setInterval(draw, 33);
      opts.onRemoteStream(remote);
      return {
        on(name, fn) { (handlers[name] ||= []).push(fn); return this; },
        set: async () => {}, replaceVideoTrack: async () => {},
        setVideoQuality: async quality => window.__qualityCalls.push(quality),
        disconnect() { window.__disconnectCalls = (window.__disconnectCalls || 0) + 1; clearInterval(timer); remote.getTracks().forEach(t => t.stop()); }
      };
    } };`,
  }));
});

async function start(page) {
  await page.goto('/app/studio');
  await page.getByRole('button', { name: 'Turn on camera', exact: true }).click();
  await expect.poll(() => page.locator('video.stage-cam').evaluate(video => video.videoWidth), { timeout: 15000 }).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Astronaut', exact: true }).click();
  await page.getByRole('button', { name: 'Use this look', exact: true }).click();
  await page.getByRole('button', { name: 'Go live', exact: true }).click();
  await expect(page.getByRole('button', { name: 'End', exact: true })).toBeVisible({ timeout: 15000 });
}

async function emit(page, metrics, count = 1) {
  await page.evaluate(({ metrics, count }) => {
    for (let i = 0; i < count; i++) window.__emitQuality(metrics);
  }, { metrics, count });
}

test('Auto shows telemetry and switches once after three consecutive upload-limited reports', async ({ page }) => {
  await start(page);
  const telemetry = page.getByTestId('live-telemetry');
  await expect(telemetry).toContainText('Sending — fps');
  await emit(page, slowUpload, 2);
  expect(await page.evaluate(() => window.__qualityInput.getSettings().width)).toBe(1280);
  await emit(page, slowUpload);
  await expect(telemetry).toContainText('Sending 10 fps');
  await expect(telemetry).toContainText('Receiving 8 fps');
  await expect(telemetry).toContainText('Delay 250 ms');
  await expect(telemetry).toContainText('Upload 0.9 Mbps');
  await expect(page.getByTestId('quality-hint')).toContainText('Your upload is limiting smoothness');
  await expect.poll(() => page.evaluate(() => window.__qualityInput.getSettings().width)).toBe(960);
  await expect.poll(() => page.evaluate(() => window.__qualityInput.getSettings().height)).toBe(540);
  expect(await page.evaluate(() => window.__qualityInput.getSettings().frameRate)).toBeLessThanOrEqual(24);
  await expect(page.getByTestId('active-quality')).toHaveText('Using Smooth');
  const toast = page.getByText('Switched to Smooth mode for a steadier picture.', { exact: true });
  await expect(toast).toHaveCount(1);
  await emit(page, slowUpload, 6);
  expect(await page.evaluate(() => window.__qualityCalls.filter(q => q.maxBitrate <= 1_200_000))).toHaveLength(1);
  expect(await page.evaluate(() => window.__connectCalls)).toBe(1);
  expect(await page.evaluate(() => window.__disconnectCalls || 0)).toBe(0);
  await expect(toast).toHaveCount(1);
});

test('manual Sharp restores 720p without reconnecting and overrides Auto', async ({ page }) => {
  await start(page);
  await emit(page, slowUpload, 3);
  await expect(page.getByTestId('active-quality')).toHaveText('Using Smooth');
  await page.getByRole('button', { name: 'Sharp', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__qualityInput.getSettings().width)).toBe(1280);
  await emit(page, slowUpload, 6);
  await expect(page.getByRole('button', { name: 'Sharp', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('active-quality')).toHaveText('Using Sharp');
  expect(await page.evaluate(() => window.__qualityCalls.at(-1))).toEqual({ maxBitrate: 2_500_000, maxFramerate: 30 });
  expect(await page.evaluate(() => window.__connectCalls)).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('vyra.quality'))).toBe('sharp');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sharp', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('Auto resets the consecutive count on recovery and respects its one-minute cooldown', async ({ page }) => {
  await page.clock.install();
  await start(page);
  await emit(page, slowUpload, 2);
  await emit(page, { ...slowUpload, receiveFps: 24, sendFps: 30 });
  await emit(page, slowUpload, 2);
  await expect(page.getByTestId('active-quality')).toHaveText('Using Sharp');
  await emit(page, slowUpload);
  await expect(page.getByTestId('active-quality')).toHaveText('Using Smooth');
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await expect(page.getByTestId('active-quality')).toHaveText('Using Sharp');
  await emit(page, slowUpload, 3);
  await expect(page.getByTestId('active-quality')).toHaveText('Using Sharp');
  await page.clock.fastForward(61000);
  await emit(page, slowUpload);
  await expect(page.getByTestId('active-quality')).toHaveText('Using Smooth');
  expect(await page.evaluate(() => window.__qualityCalls.filter(q => q.maxBitrate <= 1_200_000))).toHaveLength(2);
});

test('service and delay hints distinguish a healthy sender, and missing metrics stay blank', async ({ page }) => {
  await start(page);
  await emit(page, { receiveFps: 8, sendFps: 24, rttMs: 180, sendKbps: 1800 }, 3);
  await expect(page.getByTestId('quality-hint')).toContainText('The AI service is slow right now');
  await expect(page.getByTestId('active-quality')).toHaveText('Using Sharp');
  await emit(page, { rttMs: 451 });
  await expect(page.getByTestId('quality-hint')).toHaveText('High network delay to the AI service.');
  await expect(page.getByTestId('live-telemetry')).toContainText('Sending — fps');
  await expect(page.getByTestId('live-telemetry')).toContainText('Upload — Mbps');
});

test('quality logs every ten seconds while live and stops when the session ends', async ({ page }) => {
  const logs = [];
  page.on('console', message => { if (message.text().startsWith('[VYRA] quality')) logs.push(message.text()); });
  await page.clock.install();
  await start(page);
  await page.clock.fastForward(10000);
  await expect.poll(() => logs.length).toBe(1);
  await emit(page, { receiveFps: 24, sendFps: 30, rttMs: 180, sendKbps: 1800 });
  await page.clock.fastForward(10000);
  await expect.poll(() => logs.length).toBe(2);
  await page.getByRole('button', { name: 'End', exact: true }).click();
  await page.clock.fastForward(20000);
  expect(logs).toHaveLength(2);
  await expect(page.getByTestId('live-telemetry')).toHaveCount(0);
});

test('Smooth persists before camera startup and quality controls fit narrow screens', async ({ page }) => {
  await page.goto('/app/studio');
  await page.getByRole('button', { name: 'Smooth', exact: true }).click();
  await expect(page.getByTestId('active-quality')).toHaveText('Using Smooth');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Smooth', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Turn on camera', exact: true }).click();
  await expect.poll(() => page.locator('video.stage-cam').evaluate(video => video.srcObject?.getVideoTracks()[0]?.getSettings().width)).toBe(960);
  for (const width of [390, 280]) {
    await page.setViewportSize({ width, height: 844 });
    const control = page.locator('.quality-control');
    const bounds = await control.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    for (const button of await control.getByRole('button').all()) {
      expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
  }
});

test('the live transport updates sender encodings without opening another connection', async () => {
  let peerCount = 0, socketCount = 0;
  const sent = [];
  let parameters = { transactionId: 'keep', encodings: [{ active: true, maxBitrate: 2_500_000, maxFramerate: 30 }] };
  class Peer {
    constructor() { peerCount++; }
    addTransceiver() { return { sender: {
      getParameters: () => structuredClone(parameters),
      setParameters: async next => { sent.push(next); parameters = next; },
    } }; }
    async createOffer() { return { type: 'offer', sdp: 'test-offer' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription() {}
    close() {}
  }
  class Socket {
    static OPEN = 1;
    constructor() {
      socketCount++; this.readyState = 1;
      queueMicrotask(() => {
        this.onopen();
        this.onmessage({ data: JSON.stringify({ type: 'ready', iceServers: [{ urls: 'stun:fake.invalid' }] }) });
      });
    }
    send(message) {
      if (message.type === 'offer') queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'answer', sdp: 'test-answer' }) }));
    }
    close() { this.readyState = 3; }
  }
  const window = { MessagePack: { encode: value => value } };
  vm.runInNewContext(fs.readFileSync('person_studio/web/fal-live.js', 'utf8'), {
    window, WebSocket: Socket, RTCPeerConnection: Peer, DOMException,
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
  });
  const session = await window.FalLucy.connect({ getVideoTracks: () => [{}] }, {
    url: 'wss://fake.invalid', token: 'a.b.c', initialState: { prompt: 'test' }, onRemoteStream() {},
  });
  try {
    await session.setVideoQuality({ maxBitrate: 1_200_000, maxFramerate: 24 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ transactionId: 'keep', encodings: [{ active: true, maxBitrate: 1_200_000, maxFramerate: 24 }] });
    expect(peerCount).toBe(1);
    expect(socketCount).toBe(1);
  } finally {
    session.disconnect();
  }
});

test('photo prompts preserve the room and natural texture within 400 characters', () => {
  const built = buildSync({ entryPoints: ['frontend/src/studio/engine.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = { exports: {} };
  vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports });
  for (const description of ['bald, light stubble', 'detailed character '.repeat(60), '']) {
    const prompt = module.exports.characterPrompt(description);
    expect(prompt.toLowerCase()).toContain('keep the background');
    expect(prompt).toContain('natural skin texture');
    expect(prompt.length).toBeLessThan(400);
    expect(prompt).not.toMatch(/[\r\n]/);
  }
});
