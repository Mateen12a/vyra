const { test, expect } = require('@playwright/test');
const path = require('path');
const fixtures = path.resolve('.data/browser-fixtures');
const liveReady = { available: true, provider: 'decart', model: 'lucy-2.5', max_session_seconds: 300, message: 'Live mode is ready.' };
const devLive = { ...liveReady, vyra_dev_mode: true, streaming_available: true };
// UI checks never reach the real live service: no tokens are minted and Decart traffic is blocked.
const mockLive = async (page, status = liveReady) => {
  await page.route(/decart\.ai|fal\.(run|ai)/, (route) => route.abort());
  await page.route('**/api/live/token', (route) => route.fulfill({ status: 503, json: { detail: 'Live tokens are disabled in UI tests.' } }));
  await page.route('**/api/assist/**', (route) => route.fulfill({ status: 503, json: { detail: 'The assistant is disabled in UI tests.' } }));
  await page.route('**/api/live/status', (route) => route.fulfill({ json: status }));
};

test('live studio is the default view and fits desktop and mobile', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockLive(page);
  await page.goto('/studio');
  await expect(page.locator('#liveView')).toBeVisible();
  await expect(page.locator('#clipsView')).toBeHidden();
  await expect(page.locator('#liveStatusText')).toHaveText('Live ready');
  await expect(page.locator('#sessionCap')).toHaveText('/ 05:00');
  await page.screenshot({ path: 'test-results/live-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'test-results/live-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('going live needs a camera and a chosen look', async ({ page }) => {
  await mockLive(page);
  await page.goto('/studio');
  await page.locator('#startCameraButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'camera');
  await expect(page.locator('#goLiveButton')).toBeDisabled();
  await expect(page.locator('#goLiveLabel')).toHaveText('Pick a look to start');
  await page.locator('.look[data-name="Anime"]').click();
  await expect(page.locator('.look[data-name="Anime"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#goLiveButton')).toBeEnabled();
  await expect(page.locator('#sessionCharacter')).toHaveText('Anime');
});

test('a refused live session returns to the camera with a clear message', async ({ page }) => {
  await mockLive(page);
  await page.route('**/api/live/token', (route) => route.fulfill({ status: 503, json: { detail: 'The live service refused to start a session.' } }));
  await page.goto('/studio');
  await page.locator('#startCameraButton').click();
  await page.locator('.look[data-name="Claymation"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#notice')).toContainText('refused to start a session', { timeout: 15000 });
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'camera');
  await expect(page.locator('#goLiveLabel')).toHaveText('Ready');
});

test('a character image needs likeness consent before use', async ({ page }) => {
  await mockLive(page);
  await page.goto('/studio');
  await page.locator('#tabCharacter').click();
  await expect(page.locator('#panelCharacter')).toBeVisible();
  await page.locator('#liveRefInput').setInputFiles(path.join(fixtures, 'reference.png'));
  await expect(page.locator('#cropBox')).toHaveAttribute('data-empty', 'false');
  await expect(page.locator('#cropCanvas')).toBeVisible();
  await expect(page.locator('#applyCharacterButton')).toBeDisabled();
  await page.locator('#characterDescription').fill('Short black hair, navy sweater');
  await page.locator('#consentCheck').check();
  await page.locator('#applyCharacterButton').click();
  await expect(page.locator('#sessionCharacter')).toHaveText('Character');
});

test('live mode reports a missing server key honestly', async ({ page }) => {
  await mockLive(page, { ...liveReady, available: false, message: 'Live mode needs DECART_API_KEY on the server.' });
  await page.goto('/studio');
  await expect(page.locator('#liveStatusText')).toHaveText('Live mode needs DECART_API_KEY on the server.');
  await page.locator('.look[data-name="Anime"]').click();
  await expect(page.locator('#goLiveButton')).toBeDisabled();
});

test('clips view honestly shows its generation state', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({ json: { configured: false, live_available: false, mode: 'clip' } }));
  await page.goto('/studio#clips');
  await expect(page.locator('#clipsView')).toBeVisible();
  await expect(page.locator('#connectionLabel')).toHaveText('Connect GPU processor');
  await expect(page.locator('#transformButton')).toBeDisabled();
  await page.locator('#connectButton').click();
  await expect(page.locator('#connectionDialog')).toBeVisible();
  await page.locator('#serverUrl').fill('http://insecure-worker.example');
  await page.locator('#saveConnection').click();
  await expect(page.locator('#connectionError')).toContainText('Use HTTPS');
});

test('clips camera records a real six-second browser clip', async ({ page }) => {
  await page.goto('/studio#clips');
  await page.locator('#cameraButton').click();
  await expect(page.locator('#recordButton')).toBeVisible();
  await page.locator('#recordButton').click();
  await expect(page.locator('#recordingOverlay')).toBeVisible();
  await expect(page.locator('#sourceName')).toHaveText('camera-test.webm', { timeout: 15000 });
  await expect(page.locator('#recordingOverlay')).toBeHidden();
  await expect(page.locator('#sourceVideo')).toBeVisible();
});

test('clips camera permission denial provides a recovery path', async ({ page }) => {
  await page.goto('/studio#clips');
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Denied', 'NotAllowedError')); });
  await page.locator('#cameraButton').click();
  await expect(page.locator('#notice')).toContainText('Camera permission was denied');
  await expect(page.locator('#sourceEmpty')).toBeVisible();
  await expect(page.locator('#cameraButton')).toBeEnabled();
});

test('clip job review, download, and deletion UI', async ({ page }) => {
  // Mock GPU responses only in the browser test. Production has no fake result path.
  const job = { id: '00000000-0000-0000-0000-000000000001', status: 'queued', message: 'Waiting for the GPU',
    source: { duration_seconds: 1 }, metrics: {} };
  await page.route('**/api/health', (route) => route.fulfill({ json: { configured: true, live_available: false, mode: 'clip' } }));
  await page.route('**/api/jobs', (route) => route.fulfill({ status: 202, json: job }));
  await page.route(`**/api/jobs/${job.id}`, (route) => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 204 }) : route.fulfill({ json: { ...job, status: 'completed', message: 'Your result is ready to review',
      metrics: { total_processing_seconds: 30, processing_to_clip_ratio: 30 } } }));
  await page.route(`**/api/jobs/${job.id}/result`, (route) => route.fulfill({ path: path.join(fixtures, 'source.mp4'), contentType: 'video/mp4' }));
  await page.goto('/studio#clips');
  await page.locator('#referenceInput').setInputFiles(path.join(fixtures, 'reference.png'));
  await expect(page.locator('#referencePreview')).toBeVisible();
  await page.locator('#videoInput').setInputFiles(path.join(fixtures, 'source.mp4'));
  await expect(page.locator('#transformButton')).toBeEnabled();
  await page.locator('#transformButton').click();
  await expect(page.locator('#jobTitle')).toHaveText('Transformation ready');
  await expect(page.locator('#resultVideo')).toBeVisible();
  await expect(page.locator('#processingMetric')).toHaveText('30.0 sec');
  await expect(page.locator('#compareButton')).toBeEnabled();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#downloadButton').click();
  expect((await downloadEvent).suggestedFilename()).toBe('vyrani-clip.mp4');
  await page.locator('#deleteButton').click();
  await expect(page.locator('#jobTitle')).toHaveText('Test files deleted');
  await expect(page.locator('#resultVideo')).toBeHidden();
});

// ---------- fal engine ----------
const bothEngines = { ...liveReady, provider: 'decart', providers: [
  { id: 'decart', name: 'Decart', available: true, price_per_second: 0.02 },
  { id: 'fal', name: 'fal', available: true, price_per_second: 0.02 }] };

// A stand-in fal relay: speaks fal's msgpack signalling and answers with a real local WebRTC peer
// that streams a coloured canvas, so the whole fal path runs without the network or any spend.
const fakeFal = () => {
  window.__fal = { url: null, messages: [], sockets: 0 };
  class FakeFalSocket {
    constructor(url) {
      this.url = url; this.readyState = 0; this.binaryType = 'blob'; this.pending = [];        this.isStream = String(url).includes('/api/live/stream/');
        this.listeners = {};

      this.listeners = {};
      window.__fal.url = url; window.__fal.sockets++;
      setTimeout(() => {
        this.readyState = 1; this.dispatchEvent(new Event('open'));
        if (this.isStream) { this.reply({ type: 'ready' }); return; }
        if (window.__falHoldHandshake) return;
        if (window.__falBusy > 0) { // fal refuses the handshake while its previous live slot is closing
          window.__falBusy--;
          this.reply({ type: 'error', error: window.__falBusyMessage || 'Concurrent session limit reached.' });
          setTimeout(() => { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' })); }, 30);
          return;
        }
        this.reply({ type: 'ready', iceServers: [] });
      }, 20);
    }
    reply(message) {
      if (this.isStream) {
        setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })), 5);
        return;
      }
      const bytes = window.MessagePack.encode(message);
      setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: bytes.slice().buffer })), 5);
    }
    send(data) {
      if (this.isStream) {
        if (data === 'end') window.__stream.ended = true;
        else if (data instanceof ArrayBuffer) window.__stream.chunks++;
        return;
      }
      const message = window.MessagePack.decode(new Uint8Array(data));
      window.__fal.messages.push(message);
      this.handle(message);
    }
    async handle(message) {
      if (this.isStream) return;
      if (message.type === 'offer') {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); let hue = 0;
        const track = canvas.captureStream(30).getVideoTracks()[0];
        this.pc = new RTCPeerConnection();
        if (window.__falEchoMs != null) {
          // Echo the user's camera back __falEchoMs late, like a real engine that trails the camera.
          this.pc.ontrack = (event) => {
            const video = document.createElement('video'); video.muted = true; video.srcObject = new MediaStream([event.track]); video.play();
            const frames = [];
            this.timer = setInterval(async () => {
              if (video.readyState >= 2) { try { frames.push({ t: performance.now(), image: await createImageBitmap(video) }); } catch { /* frame not ready */ } }
              let due = null;
              while (frames.length && performance.now() - frames[0].t >= window.__falEchoMs) { due?.image.close(); due = frames.shift(); }
              if (due) { ctx.drawImage(due.image, 0, 0, 640, 360); due.image.close(); }
            }, 33);
          };
        } else {
          this.timer = setInterval(() => { hue = (hue + 7) % 360; ctx.fillStyle = 'hsl(' + hue + ' 70% 50%)'; ctx.fillRect(0, 0, 640, 360); }, 33);
        }
        this.pc.onicecandidate = (e) => this.reply({ type: 'icecandidate', candidate: e.candidate ? e.candidate.toJSON() : null });
        await this.pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        const transceiver = this.pc.getTransceivers()[0];
        await transceiver.sender.replaceTrack(track);
        transceiver.direction = 'sendrecv';
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.reply({ type: 'answer', sdp: this.pc.localDescription.sdp });
        for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c || undefined);
      } else if (message.type === 'icecandidate') {
        if (this.pc && this.pc.remoteDescription) await this.pc.addIceCandidate(message.candidate || undefined);
        else this.pending.push(message.candidate);
      } else if ('prompt' in message) {
        this.reply({ type: 'prompt_ack', success: true });
      }
    }
    addEventListener(type, callback, options) {
      (this.listeners[type] ||= []).push({ callback, once: Boolean(options?.once) });
    }
    removeEventListener(type, callback) {
      this.listeners[type] = (this.listeners[type] || []).filter((item) => item.callback !== callback);
    }
    dispatchEvent(event) {
      this[`on${event.type}`]?.(event);
      for (const item of [...(this.listeners[event.type] || [])]) {
        item.callback.call(this, event);
        if (item.once) this.removeEventListener(event.type, item.callback);
      }
      return true;
    }
    close() { this.readyState = 3; clearInterval(this.timer); if (this.pc) this.pc.close(); this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' })); }
  }
  FakeFalSocket.OPEN = 1; FakeFalSocket.CLOSING = 2; FakeFalSocket.CLOSED = 3;
  window.WebSocket = FakeFalSocket;
};

const mockFal = async (page) => {
  await mockLive(page, bothEngines);
  await page.route('**/api/live/token', (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.provider !== 'fal') return route.fulfill({ status: 503, json: { detail: 'Only fal in this test.' } });
    return route.fulfill({ json: { provider: 'fal', token: 'hdr.claims.sig', url: 'wss://fal.test/decart/lucy-2-5/realtime',
      max_session_seconds: 300, price_per_second: 0.02 } });
  });
  await page.addInitScript(fakeFal);
};

test('engine switch lists both engines and remembers the choice', async ({ page }) => {
  await mockLive(page, bothEngines);
  await page.goto('/studio');
  await expect(page.locator('#engineSelect')).toBeVisible();
  await expect(page.locator('#engineSelect option')).toHaveText(['Decart', 'Lucy via fal']);
  await expect(page.locator('#liveStatusText')).toHaveText('Live ready · Decart');
  await page.locator('#engineSelect').selectOption('fal');
  await expect(page.locator('#liveStatusText')).toHaveText('Live ready · Lucy via fal');
  await expect(page.locator('#sessionEngine')).toHaveText('Lucy via fal');
  await page.reload();
  await expect(page.locator('#engineSelect')).toHaveValue('fal');
});

test('a full fal session: looks, character, prompt enhancement, recording and stop', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockFal(page);
  await page.goto('/studio');
  await page.locator('#engineSelect').selectOption('fal');
  await page.locator('#startCameraButton').click();
  await page.locator('.look[data-name="Anime"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'live', { timeout: 20000 });
  await expect(page.locator('#engineSelect')).toBeDisabled();
  const fal = () => page.evaluate(() => window.__fal);
  const prompts = async () => (await fal()).messages.filter((m) => 'prompt' in m || 'reference_image_url' in m);
  let state = await fal();
  expect(state.url).toBe('wss://fal.test/decart/lucy-2-5/realtime?fal_jwt_token=hdr.claims.sig');
  // Settings first, then the offer, then trickled candidates: the ordering fal's relay expects.
  expect(state.messages[0].prompt).toContain('anime');
  expect(state.messages[0].enable_prompt_expansion).toBe(true);
  expect('reference_image_url' in state.messages[0]).toBe(false);
  expect(state.messages.findIndex((m) => m.type === 'offer')).toBeGreaterThan(0);
  expect(state.messages.filter((m) => m.type === 'icecandidate').length).toBeGreaterThan(0);
  await expect(page.locator('#telemetry')).toContainText('fps');

  // Record the AI output and download it.
  await expect(page.locator('#liveRecordButton')).toBeEnabled();
  await page.locator('#liveRecordButton').click();
  await expect(page.locator('#liveRecordBadge')).toBeVisible();
  await page.waitForTimeout(1500);
  const download = page.waitForEvent('download');
  await page.locator('#liveRecordButton').click();
  const recording = await download;
  expect(recording.suggestedFilename()).toMatch(/^vyrani-\d{8}-\d{6}\.(mp4|webm)$/);
  await recording.saveAs('test-results/live-recording-sample.' + recording.suggestedFilename().split('.').pop());
  if (recording.suggestedFilename().endsWith('.mp4'))
    expect(require('fs').readFileSync('test-results/live-recording-sample.mp4').toString('latin1')).toContain('Made with VYRANI AI');

  // Character swap sends the framed photo; going back to a look removes it explicitly.
  await page.locator('#tabCharacter').click();
  await page.locator('#liveRefInput').setInputFiles(path.join(fixtures, 'reference.png'));
  await page.locator('#characterDescription').fill('Short black hair, navy sweater');
  await page.locator('#consentCheck').check();
  await page.locator('#applyCharacterButton').click();
  // Reference-image framing/encoding shares the CPU with recording; retain the message assertion
  // while allowing that asynchronous work a larger budget than the default five seconds.
  await expect.poll(async () => (await prompts()).length, { timeout: 15000 }).toBe(2);
  const swap = (await prompts())[1];
  expect(swap.reference_image_url).toMatch(/^data:image\/jpeg;base64,/);
  expect(swap.prompt).toContain('Short black hair, navy sweater');
  await page.locator('#tabLooks').click();
  await page.locator('.look[data-name="Comic"]').click();
  await expect.poll(async () => (await prompts()).length).toBe(3);
  expect((await prompts())[2].reference_image_url).toBeNull();

  // Exact wording mode is sent live.
  await page.locator('#promptDetails summary').click();
  await page.locator('#enhanceCheck').uncheck();
  await expect.poll(async () => (await prompts()).at(-1).enable_prompt_expansion).toBe(false);

  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'camera');
  await expect(page.locator('#engineSelect')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a refused fal session returns to the camera with a clear message', async ({ page }) => {
  await mockLive(page, bothEngines);
  await page.route('**/api/live/token', (route) => route.fulfill({ status: 503, json: { detail: 'fal live mode is not configured on this server.' } }));
  await page.goto('/studio');
  await page.locator('#engineSelect').selectOption('fal');
  await page.locator('#startCameraButton').click();
  await page.locator('.look[data-name="Claymation"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#notice')).toContainText('not configured', { timeout: 15000 });
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'camera');
});

// ---------- prompt assistant ----------
test('a few words become a saved look, and a photo describes itself', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockLive(page, { ...bothEngines, assist: true });
  const ideas = [];
  await page.route('**/api/assist/look', async (route) => {
    ideas.push(route.request().postDataJSON().idea);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ json: { name: 'Pirate Captain', note: 'Ruler of the seas',
      prompt: 'Dress the person in a weathered tricorn hat and a velvet captain coat; keep the face visible.' } });
  });
  let described = 0;
  await page.route('**/api/assist/describe', async (route) => {
    described++;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ json: { description: 'Dark brown skin, oval face, short buzz cut, light grey t-shirt' } });
  });
  await page.goto('/studio');
  await expect(page.locator('#createForm')).toBeVisible();
  await expect(page.locator('#createButton')).toBeDisabled();
  await page.locator('#createInput').fill('pirate captain');
  await page.locator('#createButton').click();
  await expect(page.locator('#createButton')).toHaveText('Creating');
  await expect(page.locator('.look.mine[data-name="Pirate Captain"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sessionCharacter')).toHaveText('Pirate Captain');
  await expect(page.locator('#goLiveLabel')).toHaveText('Ready');
  await expect(page.locator('#createInput')).toHaveValue('');
  await expect(page.locator('#promptInput')).toHaveValue(/tricorn hat/);
  expect(ideas).toEqual(['pirate captain']);
  // Created looks survive a reload, listed first.
  await page.reload();
  await expect(page.locator('.look').first()).toHaveAttribute('data-name', 'Pirate Captain');

  await page.locator('#tabCharacter').click();
  await page.locator('#liveRefInput').setInputFiles(path.join(fixtures, 'reference.png'));
  await expect(page.locator('#describeStatus')).toBeVisible();
  await page.locator('#consentCheck').check();
  await expect(page.locator('#applyCharacterButton')).toBeDisabled(); // wait for the description
  await expect(page.locator('#characterDescription')).toHaveValue('Dark brown skin, oval face, short buzz cut, light grey t-shirt');
  await expect(page.locator('#describeHint')).toBeVisible();
  await expect(page.locator('#applyCharacterButton')).toBeEnabled();
  // The user's own words are never overwritten by a later photo.
  await page.locator('#characterDescription').fill('Tall, red beanie');
  await page.locator('#cropReplace').click();
  await page.locator('#liveRefInput').setInputFiles(path.join(fixtures, 'reference.png'));
  await page.waitForTimeout(800);
  await expect(page.locator('#characterDescription')).toHaveValue('Tall, red beanie');
  expect(described).toBe(1);
  expect(errors).toEqual([]);
});

test('development mode removes only VYRANI output labels and metadata', async ({ page }) => {
  await mockFal(page);
  await page.route('**/api/live/status', (route) => route.fulfill({ json: { ...withVoices, vyra_dev_mode: true, streaming_available: true, ai_label: true } }));
  await page.addInitScript(() => { window.__falEchoMs = 300; });
  await page.goto('/studio');
  await page.locator('#engineSelect').selectOption('fal');
  await page.locator('#startCameraButton').click();
  await page.locator('.look[data-name="Anime"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'live', { timeout: 20000 });
  await expect(page.locator('#aiLabel')).toBeHidden(); // server asks for a mark, explicit development mode removes VYRANI's mark
  await expect(page.locator('#streamButton')).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#liveRecordButton').click();
  await page.waitForTimeout(1200);
  await page.locator('#liveRecordButton').click();
  const download = await downloadEvent;
  const file = 'test-results/dev-output-' + download.suggestedFilename().split('.').pop();
  await download.saveAs(file);
  const bytes = require('fs').readFileSync(file).toString('latin1');
  expect(bytes).not.toContain('Made with VYRANI AI');
  expect(bytes).not.toContain('VYRANI AI recording');
  await page.locator('#goLiveButton').click();
});

test('stream button sends composited AI video to the local RTMP relay and stops cleanly', async ({ page }) => {
  await mockFal(page);
  await page.route('**/api/live/status', (route) => route.fulfill({ json: { ...bothEngines, streaming_available: true } }));
  await page.route('**/api/live/stream/ticket', (route) => route.fulfill({ json: { ticket: 'one-use-test-ticket' } }));
  await page.addInitScript(() => {
    window.__stream = { chunks: 0, ended: false };
    const OriginalRecorder = window.MediaRecorder;
    window.MediaRecorder = class extends OriginalRecorder {
      start(timeslice) {
        super.start(timeslice);
        this.__streamTimer = setInterval(() => {
          if (this.state === 'recording') this.dispatchEvent(new BlobEvent('dataavailable', { data: new Blob([new Uint8Array(300000)]) }));
        }, timeslice || 100);
      }
      stop() { clearInterval(this.__streamTimer); return super.stop(); }
    };
  });
  await page.goto('/studio');
  await page.locator('#engineSelect').selectOption('fal');
  await page.locator('#startCameraButton').click();
  await page.locator('.look[data-name="Anime"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'live', { timeout: 20000 });
  await expect(page.locator('#streamButton')).toBeVisible();
  await page.locator('#streamButton').click();
  await expect(page.locator('#streamHint')).toContainText('configured RTMP destination');
  await page.waitForFunction(() => window.__stream.chunks > 1);
  await page.locator('#streamButton').click();
  await expect(page.locator('#streamHint')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__stream.ended)).toBe(true);
  await page.locator('#goLiveButton').click();
});

test('a busy fal slot is retried through its cleanup window', async ({ page }) => {
  await mockFal(page);
  await page.addInitScript(() => {
    window.__falBusy = 7;
    window.__falBusyMessage = 'The session is busy';
    window.VYRA_FAL_RETRY_MS = 300;
  });
  await page.goto('/studio');
  await page.locator('#engineSelect').selectOption('fal');
  await page.locator('#startCameraButton').click();
  await page.locator('.look[data-name="Anime"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#warmupText')).toContainText('Previous session still closing');
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'live', { timeout: 20000 });
  expect(await page.evaluate(() => window.__fal.sockets)).toBe(8);
  await expect(page.locator('#notice')).toBeHidden();
});

test('stopping while fal is busy cancels the pending retry immediately', async ({ page }) => {
  await mockFal(page);
  await page.addInitScript(() => {
    window.__falBusy = 1;
    window.VYRA_FAL_RETRY_MS = 20000;
  });
  await page.goto('/studio');
  await page.locator('#engineSelect').selectOption('fal');
  await page.locator('#startCameraButton').click();
  await page.locator('.look[data-name="Anime"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#warmupText')).toContainText('Previous session still closing');
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'camera');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__fal.sockets)).toBe(1);
  await expect(page.locator('#goLiveLabel')).toHaveText('Ready');
});

test('stopping during a fal handshake aborts the pending websocket cleanly', async ({ page }) => {
  await mockFal(page);
  await page.addInitScript(() => { window.__falHoldHandshake = true; });
  await page.goto('/studio');
  await page.locator('#engineSelect').selectOption('fal');
  await page.locator('#startCameraButton').click();
  await page.locator('.look[data-name="Anime"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'connecting');
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'camera');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__fal.sockets)).toBe(1);
  await expect(page.locator('#goLiveLabel')).toHaveText('Ready');
});

test('without the assistant the page still works by hand', async ({ page }) => {
  await mockLive(page, { ...liveReady, assist: false });
  await page.goto('/studio');
  await expect(page.locator('#createForm')).toBeHidden();
  await page.locator('#promptDetails summary').click();
  await page.locator('#promptInput').fill('Dress the person in a yellow raincoat.');
  await page.locator('#promptButton').click();
  await expect(page.locator('#sessionCharacter')).toHaveText('Custom');
});

// ---------- voice ----------
test('the voice shifter moves pitch independently, and Male/Female adapt to the speaker', async ({ page }) => {
  await mockLive(page);
  await page.goto('/studio');
  const measured = await page.evaluate(async () => {
    // A buzzy "voice": a sawtooth at the given pitch through a vowel-like band, then the shifter.
    const render = async (hz, options) => {
      const rate = 48000, ctx = new OfflineAudioContext(1, rate * 2, rate);
      await ctx.audioWorklet.addModule('/assets/voice-worklet.js');
      const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: hz });
      const vowel = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1200 });
      const shift = new AudioWorkletNode(ctx, 'vyra-shift', { outputChannelCount: [1], processorOptions: options });
      osc.connect(vowel).connect(shift).connect(ctx.destination); osc.start();
      return (await ctx.startRendering()).getChannelData(0).slice(rate); // the second second, after it settles
    };
    // Median pitch by autocorrelation over 40 ms frames.
    const pitch = (x, rate = 48000) => {
      const found = [];
      for (let at = 0; at + 1920 < x.length; at += 960) {
        const sums = [];
        for (let lag = 100; lag < 700; lag++) {
          let sum = 0;
          for (let i = 0; i < 1200; i++) sum += x[at + i] * x[at + i + lag];
          sums.push(sum);
        }
        // The first peak close to the strongest one is the period (later peaks are its multiples).
        const best = Math.max(...sums);
        const lag = sums.findIndex((v, i) => v >= best * 0.85 && v >= (sums[i - 1] ?? -Infinity) && v >= (sums[i + 1] ?? -Infinity));
        if (best > 0 && lag >= 0) found.push(rate / (lag + 100));
      }
      found.sort((a, b) => a - b);
      return found[found.length >> 1];
    };
    return {
      down: pitch(await render(140, { pitch: 0.78, formant: 1 })),
      up: pitch(await render(140, { pitch: 1.55, formant: 1 })),
      maleFromHigh: pitch(await render(210, { targetHz: 115 })),
      femaleFromLow: pitch(await render(110, { targetHz: 215 })),
      femaleFromFemale: pitch(await render(210, { targetHz: 215 })),
    };
  });
  const near = (value, want, tolerance = 0.08) => expect(Math.abs(value - want) / want, `${value} vs ${want}`).toBeLessThan(tolerance);
  near(measured.down, 140 * 0.78);
  near(measured.up, 140 * 1.55);
  near(measured.maleFromHigh, 115, 0.12);
  near(measured.femaleFromLow, 215, 0.12);
  near(measured.femaleFromFemale, 215, 0.12); // already female: stays put instead of going squeaky
});

test('the lip-sync matcher finds a known delay in motion data', async ({ page }) => {
  await mockLive(page);
  await page.goto('/studio');
  const lag = await page.evaluate(() => {
    let seed = 7; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const early = Array.from({ length: 180 }, () => (rand() > 0.85 ? 10 * rand() : rand()));
    const late = early.map((_, i) => (early[i - 12] ?? 0) * 0.7 + rand() * 0.8); // 12 samples late, dimmer, noisy
    return window.VyraVoice.bestLag(early, late, 45);
  });
  expect(lag.lag).toBe(12);
  expect(lag.r).toBeGreaterThan(0.5);
});

test('voices: effects switch, the mic stays local, recordings carry the voice in sync', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockFal(page);
  await page.addInitScript(() => { window.__falEchoMs = 400; });
  await page.goto('/studio');
  await page.locator('#engineSelect').selectOption('fal');
  await page.locator('#tabVoice').click();
  await expect(page.locator('#voiceGrid .voice')).toHaveText([/^Off/, /^Natural/, /^Male/, /^Female/, /^Deep/, /^Cartoon/, /^Robot/, /^Radio/, /^Monster/, /^Cave/]);
  await expect(page.locator('#accentGroup')).toBeHidden(); // this server offers no AI voices
  await expect(page.locator('.voice[data-voice="natural"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#startCameraButton').click();
  await expect(page.locator('#voiceState')).toHaveText('Mic on · Natural');
  await expect(page.locator('#sessionVoice')).toHaveText('Natural');
  // Chrome's fake microphone plays a beep: the level meter must move.
  await expect.poll(() => page.evaluate(() => Number(document.getElementById('voiceLevel').style.getPropertyValue('--level') || 0)),
    { timeout: 5000 }).toBeGreaterThan(0.01);
  for (const id of ['male', 'female', 'deep', 'robot', 'radio', 'monster', 'cave', 'cartoon']) {
    await page.locator(`.voice[data-voice="${id}"]`).click();
    await expect(page.locator(`.voice[data-voice="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
  }
  await page.locator('.voice[data-voice="deep"]').click();
  await expect(page.locator('#voiceState')).toHaveText('Mic on · Deep');

  await page.locator('#tabLooks').click();
  await page.locator('.look[data-name="Anime"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'live', { timeout: 20000 });
  // The engine only ever receives video: the offer carries no audio section.
  const offer = (await page.evaluate(() => window.__fal.messages)).find((m) => m.type === 'offer');
  expect(offer.sdp).not.toContain('m=audio');

  // The voice is delayed by the measured video delay (the fake engine trails the camera by 400 ms).
  await expect.poll(() => page.evaluate(() => window.vyraVoiceDebug().measuredLag), { timeout: 15000, intervals: [1000] }).not.toBeNull();
  const sync = await page.evaluate(() => window.vyraVoiceDebug());
  expect(sync.measuredLag).toBeGreaterThan(330);
  expect(sync.measuredLag).toBeLessThan(700);
  await expect(page.locator('#voiceState')).toHaveText(/^Sync \d+ ms$/);

  await page.locator('#liveRecordButton').click();
  await page.waitForTimeout(2000);
  const download = page.waitForEvent('download');
  await page.locator('#liveRecordButton').click();
  const recording = await download;
  const file = 'test-results/voice-recording-sample.' + recording.suggestedFilename().split('.').pop();
  await recording.saveAs(file);
  const bytes = require('fs').readFileSync(file).toString('latin1');
  expect(/mp4a|Opus|A_OPUS/.test(bytes)).toBe(true); // an audio track is in the file

  // Lip-sync nudge adds to the automatic delay; Off closes the microphone.
  await page.locator('#tabVoice').click();
  await page.locator('#syncDetails summary').click();
  await page.locator('#syncRange').fill('100');
  await expect(page.locator('#syncValue')).toHaveText('Auto +100');
  await expect.poll(() => page.evaluate(() => { const d = window.vyraVoiceDebug(); return Math.round(d.delayMs - (d.measuredLag ?? d.estimatedLag)); })).toBe(100);
  await page.locator('.voice[data-voice="off"]').click();
  await expect(page.locator('#voiceState')).toHaveText('Mic off');
  expect(await page.evaluate(() => window.vyraVoiceDebug().open)).toBe(false);
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'camera');
  await page.reload();
  await page.locator('#tabVoice').click();
  await expect(page.locator('.voice[data-voice="off"]')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('a blocked microphone never blocks going live', async ({ page, context }) => {
  await context.clearPermissions();
  await context.grantPermissions(['camera']);
  await mockFal(page);
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => constraints.audio
      ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : original(constraints);
  });
  await page.goto('/studio');
  await page.locator('#engineSelect').selectOption('fal');
  await page.locator('#startCameraButton').click();
  await expect(page.locator('#notice')).toContainText('Microphone permission was denied');
  await page.locator('.look[data-name="Anime"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'live', { timeout: 20000 });
  await expect(page.locator('#sessionVoice')).toHaveText('Mic blocked');
  await page.locator('#goLiveButton').click();
});

test('every voice effect stays audible and never runs away in volume', async ({ page }) => {
  await mockLive(page);
  await page.goto('/studio');
  const levels = await page.evaluate(async () => {
    const out = {};
    for (const { id } of window.VyraVoice.VOICES.filter((v) => v.id !== 'off')) {
      const rate = 48000, ctx = new OfflineAudioContext(1, rate * 2, rate);
      await ctx.audioWorklet.addModule('/assets/voice-worklet.js');
      // A rough voice: a 140 Hz buzz switching on and off like syllables.
      const buzz = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 140 }), syllables = new GainNode(ctx, { gain: 0 });
      for (let t = 0; t < 2; t += 0.25) syllables.gain.setValueAtTime((t * 4) % 2 < 1 ? 0.3 : 0, t);
      const effect = window.VyraVoice.buildEffect(ctx, id, true);
      buzz.connect(syllables).connect(effect.input); effect.output.connect(ctx.destination); buzz.start();
      const data = (await ctx.startRendering()).getChannelData(0);
      let sum = 0, peak = 0;
      for (const v of data) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
      out[id] = { rms: Math.sqrt(sum / data.length), peak };
    }
    return out;
  });
  for (const [id, { rms, peak }] of Object.entries(levels)) {
    expect(rms, id).toBeGreaterThan(0.02);
    expect(peak, id).toBeLessThan(1.5);
  }
});

// ---------- AI accent voices ----------
const withVoices = { ...bothEngines, voice_price_per_minute: 0.3, voices: [
  { id: 'american-male', accent: 'American', gender: 'male', voice: 'Brian' },
  { id: 'british-male', accent: 'British', gender: 'male', voice: 'George' },
  { id: 'british-female', accent: 'British', gender: 'female', voice: 'Lily' },
  { id: 'swedish-female', accent: 'Swedish', gender: 'female', voice: 'Charlotte' }] };

const recordWithAccent = async (page, convert) => {
  await mockFal(page);
  await page.route('**/api/live/status', (route) => route.fulfill({ json: withVoices }));
  await page.route('**/api/voice/convert', convert);
  await page.addInitScript(() => { window.__falEchoMs = 300; });
  await page.goto('/studio');
  await page.locator('#engineSelect').selectOption('fal');
  await page.locator('#tabVoice').click();
  await expect(page.locator('#accentGroup')).toBeVisible();
  await expect(page.locator('.accent-row')).toHaveText([/American\s*Male\s*—/, /British\s*Male\s*Female/, /Swedish\s*—\s*Female/]);
  await expect(page.locator('#accentPrice')).toHaveText('$0.30 / MIN');
  await page.locator('.voice[data-voice="ai:british-male"]').click();
  await expect(page.locator('#accentHint')).toBeVisible();
  await page.locator('#startCameraButton').click();
  await expect(page.locator('#voiceState')).toHaveText('Mic on · British male');
  await page.locator('#tabLooks').click();
  await page.locator('.look[data-name="Anime"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'live', { timeout: 20000 });
  await page.locator('#liveRecordButton').click();
  await page.waitForTimeout(2500);
  const download = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('#liveRecordButton').click();
  return download;
};

test('an accent voice replaces the recorded voice in the saved MP4', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sent = [];
  const voice = require('fs').readFileSync(path.join(fixtures, 'voice-george.mp3'));
  const download = await recordWithAccent(page, (route) => {
    sent.push(route.request().postDataBuffer());
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: voice });
  });
  const recording = await download;
  expect(recording.suggestedFilename()).toMatch(/^vyrani-\d{8}-\d{6}-british-male\.mp4$/);
  const file = 'test-results/accent-recording-sample.mp4';
  await recording.saveAs(file);
  // The server got a WAV of the recorded voice and the chosen preset, nothing else.
  const body = sent[0].toString('latin1');
  expect(body).toContain('name="voice"\r\n\r\nbritish-male');
  expect(body).toContain('RIFF');
  expect(body).toContain('WAVEfmt ');
  const bytes = require('fs').readFileSync(file).toString('latin1');
  expect(bytes).toContain('avc1'); // the video, copied
  expect(/mp4a|Opus/.test(bytes)).toBe(true); // the new voice
  expect(bytes).toContain('Made with VYRANI AI'); // the hidden provenance tag
  await expect(page.locator('#notice')).toContainText('-british-male.mp4');
  expect(errors).toEqual([]);
});

test('if the accent voice fails, the recording is still saved with the own voice', async ({ page }) => {
  const download = await recordWithAccent(page, (route) =>
    route.fulfill({ status: 503, json: { detail: 'Your fal balance is too low. Top up at fal.ai.' } }));
  const recording = await download;
  expect(recording.suggestedFilename()).toMatch(/^vyrani-\d{8}-\d{6}\.mp4$/);
  await expect(page.locator('#notice')).toContainText('Your fal balance is too low');
  await expect(page.locator('#notice')).toContainText('Saved with your own voice instead');
});

// ---------- network and colour ----------
test('users see their network: live stats, signal bars, and a connection test', async ({ page }) => {
  await mockFal(page);
  await page.goto('/studio');
  await expect(page.locator('#netLabel')).toHaveText('Not measured');
  // The connection test (against this server) fills in latency and upload.
  await page.locator('#netTestButton').click();
  await expect(page.locator('#netUpload')).toHaveText(/^\d+\.\d Mbit\/s$/, { timeout: 20000 });
  await expect(page.locator('#netLatency')).toHaveText(/^\d+ ms$/);
  await expect(page.locator('#netLabel')).toHaveText(/Excellent|Good|Fair|Poor/);
  await expect(page.locator('#notice')).toContainText('running on this computer'); // honest about a local server
  // Live: real WebRTC stats replace it, and the stage shows signal bars.
  await page.locator('#engineSelect').selectOption('fal');
  await page.locator('#startCameraButton').click();
  await page.locator('.look[data-name="Anime"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'live', { timeout: 20000 });
  await expect(page.locator('#hudSignal')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#netFps')).toHaveText(/^\d+ fps$/);
  await expect(page.locator('#netLoss')).toHaveText(/^\d+\.\d %$/);
  await expect(page.locator('#netUpload')).toHaveText(/Mbit\/s$/);
  await page.locator('#goLiveButton').click();
});

test('network tips explain a slow upload in plain words', async ({ page }) => {
  await mockLive(page);
  await page.route('**/api/net/probe', async (route) => {
    if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 9000)); // ~1.8 Mbit/s for 2 MB
    route.fulfill({ json: { ok: true } });
  });
  await page.goto('/studio');
  await page.locator('#netTestButton').click();
  await expect(page.locator('#netTip')).toContainText('upload speed is limiting', { timeout: 40000 });
  await expect(page.locator('#netSignal')).toHaveAttribute('data-level', /^[12]$/);
});

test('the colour theme can be switched and is remembered', async ({ page }) => {
  await mockLive(page);
  await page.goto('/studio');
  await expect(page.locator('.swatch')).toHaveCount(4);
  const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  expect(await accent()).toBe('#FF6B2B');
  await page.locator('.swatch[data-palette="ice"]').click();
  expect(await accent()).toBe('#4FB8FF');
  await page.reload();
  expect(await accent()).toBe('#4FB8FF');
  await expect(page.locator('.swatch[data-palette="ice"]')).toHaveAttribute('aria-pressed', 'true');
});

test('the VYRANI · AI label follows the server setting', async ({ page }) => {
  await mockLive(page, { ...liveReady, ai_label: false });
  await page.goto('/studio');
  await expect(page.locator('#aiLabel')).toBeHidden();
  await expect(page.locator('#sessionHint')).not.toContainText('labelled as AI');
  await mockLive(page, { ...liveReady, ai_label: true });
  await page.reload();
  await expect(page.locator('#aiLabel')).toBeAttached();
  await expect(page.locator('#aiLabel')).not.toHaveAttribute('hidden', '');
  await expect(page.locator('#sessionHint')).toContainText('labelled as AI');
});

// ---------- sources, scenes, overlay, voice commands ----------
test('a video file can be the live source instead of the camera', async ({ page }) => {
  await mockFal(page);
  await page.addInitScript(() => { window.__falEchoMs = 200; });
  await page.goto('/studio');
  await page.locator('#engineSelect').selectOption('fal');
  await expect(page.locator('#cameraSelect option')).toContainText(['Video file…']);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#cameraSelect').selectOption('__file');
  await (await chooser).setFiles(path.join(fixtures, 'source.mp4'));
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'camera');
  await expect(page.locator('#cameraSelect')).toHaveValue('__file');
  await expect(page.locator('#cameraSelect option:checked')).toHaveText('Video: source.mp4');
  await expect(page.locator('#mirrorButton')).toHaveAttribute('aria-pressed', 'false'); // a file is never mirrored
  await page.locator('.look[data-name="Comic"]').click();
  await page.locator('#goLiveButton').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-state', 'live', { timeout: 20000 });
  expect((await page.evaluate(() => window.__fal.messages)).some((m) => m.type === 'offer')).toBe(true);
  await page.locator('#goLiveButton').click();
});

test('the on-device detector loads and finds a person in a real photo', async ({ page }) => {
  await mockLive(page);
  await page.goto('/studio');
  const photo = require('fs').readFileSync(path.join(fixtures, 'person.jpg')).toString('base64');
  const seen = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/jpeg;base64,${b64}`; await img.decode();
    const canvas = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight });
    canvas.getContext('2d').drawImage(img, 0, 0);
    return [...await window.VyraScenes.signals(canvas, performance.now())];
  }, photo);
  expect(seen).not.toContain('absent:person'); // a person was found
});

test('scene rules fire on a trigger and undo when it stops', async ({ page }) => {
  await mockLive(page);
  await page.addInitScript(() => { window.__vyraSceneSignals = []; });
  await page.goto('/studio');
  await page.locator('#startCameraButton').click();
  await page.locator('.look[data-name="Anime"]').click();
  await page.locator('#tabScenes').click();
  await page.locator('#ruleTrigger').selectOption('gesture:Thumb_Up');
  await page.locator('#ruleAction').selectOption('look:Comic');
  await page.locator('#ruleForm button').click();
  await expect(page.locator('.rule')).toHaveCount(1);
  await expect(page.locator('.rule')).toContainText('You give a thumbs up → Switch to Comic · undo after');
  await expect(page.locator('#rulesState')).toHaveText('WATCHING', { timeout: 30000 }); // the real models loaded
  await page.evaluate(() => { window.__vyraSceneSignals = ['gesture:Thumb_Up']; });
  await expect(page.locator('#sessionCharacter')).toHaveText('Comic', { timeout: 5000 });
  await expect(page.locator('#commandToast')).toContainText('thumbs up');
  await expect(page.locator('.rule')).toHaveAttribute('data-active', 'true');
  await page.evaluate(() => { window.__vyraSceneSignals = []; });
  await expect(page.locator('#sessionCharacter')).toHaveText('Anime', { timeout: 5000 });
  // Rules are remembered.
  await page.reload();
  await page.locator('#tabScenes').click();
  await expect(page.locator('.rule')).toHaveCount(1);
  await expect(page.locator('#rulesEnabled')).toBeChecked();
});

test('the banner overlay shows on the stage and a rule can show it', async ({ page }) => {
  await mockLive(page);
  await page.addInitScript(() => { window.__vyraSceneSignals = []; });
  await page.goto('/studio');
  await page.locator('#startCameraButton').click();
  await page.locator('#tabScenes').click();
  await page.locator('#overlayToggle').click();
  await expect(page.locator('#notice')).toContainText('Add a banner title');
  await page.locator('#overlayTitle').fill('Live from Lagos');
  await page.locator('#overlaySub').fill('Product launch');
  await page.locator('#overlayToggle').click();
  await expect(page.locator('#overlay')).toBeVisible();
  await expect(page.locator('#overlay')).toContainText('Live from Lagos');
  await page.locator('#overlayToggle').click();
  await expect(page.locator('#overlay')).toBeHidden();
  await page.locator('#ruleTrigger').selectOption('object:cup');
  await page.locator('#ruleAction').selectOption('overlay:show');
  await page.locator('#ruleForm button').click();
  await expect(page.locator('#rulesState')).toHaveText('WATCHING', { timeout: 30000 });
  await page.evaluate(() => { window.__vyraSceneSignals = ['object:cup']; });
  await expect(page.locator('#overlay')).toBeVisible({ timeout: 5000 });
  await page.evaluate(() => { window.__vyraSceneSignals = []; });
  await expect(page.locator('#overlay')).toBeHidden({ timeout: 5000 });
});

const fakeSpeech = () => {
  window.SpeechRecognition = class {
    constructor() { window.__speech = this; this.started = false; }
    start() { this.started = true; setTimeout(() => this.onstart?.(), 5); }
    stop() { this.started = false; setTimeout(() => this.onend?.(), 5); }
  };
  window.__say = (text) => window.__speech.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
};

test('voice commands: hold to talk switches looks and voices, and edits the scene', async ({ page }) => {
  await mockLive(page, { ...liveReady, assist: true });
  const edits = [];
  await page.route('**/api/assist/look', (route) => {
    edits.push(route.request().postDataJSON());
    route.fulfill({ json: { name: 'Snowy Anime', note: 'Anime in snowfall', prompt: 'Restyle the entire scene as anime with heavy snowfall.' } });
  });
  await page.addInitScript(fakeSpeech);
  await page.goto('/studio');
  await page.locator('.look[data-name="Anime"]').click();
  await page.locator('#tabScenes').click();
  await page.locator('[data-command-mode="hold"]').click();
  await expect(page.locator('#commandState')).toHaveText('Hold V');
  await expect(page.locator('#commandButton')).toBeVisible();
  const say = async (text) => {
    await page.keyboard.down('v');
    await expect.poll(() => page.evaluate(() => window.__speech.started)).toBe(true);
    await page.evaluate((t) => window.__say(t), text);
    await page.keyboard.up('v');
  };
  await say('switch to comic');
  await expect(page.locator('#sessionCharacter')).toHaveText('Comic');
  await expect(page.locator('#commandLast')).toContainText('“switch to comic” → Comic on');
  await say('female voice');
  await expect(page.locator('#sessionVoice')).toHaveText('Female');
  await page.locator('#tabLooks').click();
  await page.locator('.look[data-name="Anime"]').click();
  await say('make it snow');
  await expect(page.locator('#sessionCharacter')).toHaveText('Snowy Anime');
  expect(edits[0].idea).toBe('make it snow');
  expect(edits[0].base).toContain('anime'); // the current look is kept and edited
  // Typing a "v" in a text box never triggers a command.
  await page.locator('#tabLooks').click();
  await page.locator('#createInput').fill('');
  await page.locator('#createInput').press('v');
  expect(await page.evaluate(() => window.__speech.started)).toBe(false);
});

test('voice commands: hands-free only acts on "Vyrani, ..."', async ({ page }) => {
  await mockLive(page);
  await page.addInitScript(fakeSpeech);
  await page.goto('/studio');
  await page.locator('#startCameraButton').click();
  await page.locator('#tabScenes').click();
  await page.locator('#overlayTitle').fill('Hello Lagos');
  await page.locator('[data-command-mode="handsfree"]').click();
  await expect(page.locator('#commandState')).toHaveText('Listening');
  await page.evaluate(() => window.__say('show the banner'));
  await expect(page.locator('#overlay')).toBeHidden(); // no wake word
  await page.evaluate(() => window.__say('Vyrani, show the banner'));
  await expect(page.locator('#overlay')).toBeVisible();
  await page.evaluate(() => window.__say('Vyrani hide the banner'));
  await expect(page.locator('#overlay')).toBeHidden();
  await page.reload(); // the mode is remembered
  await page.locator('#tabScenes').click();
  await expect(page.locator('[data-command-mode="handsfree"]')).toHaveAttribute('aria-pressed', 'true');
});
