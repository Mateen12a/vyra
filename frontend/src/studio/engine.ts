// Live engine glue for the React studio. The transport clients are the proven ones from the classic studio
// (/assets/fal-live.js for Lucy via fal); this module loads it,
// mints server tokens inside the user's paid session, and wraps billing heartbeats.
import { api, ApiError } from "../lib/api";
import type { VideoQuality } from "./quality";

export type LiveState = { image?: Blob | null; prompt: string; enhance: boolean };
export type Session = {
  set(state: { image: Blob | null; prompt: string; enhance: boolean }): Promise<void>;
  disconnect(): void;
  replaceVideoTrack?(track: MediaStreamTrack): Promise<void>;
  setVideoQuality?(quality: Pick<VideoQuality, "maxBitrate" | "maxFramerate">): Promise<void>;
  on(event: string, fn: (payload: any) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
};
export type AccentVoice = { id: string; voice: string; accent: string; gender: string; name?: string; note?: string };
export type LiveStatus = {
  available: boolean; provider: string; model: string; max_session_seconds: number; message: string;
  providers: { id: string; name: string; available: boolean }[]; ai_label: boolean; can_remove_watermark?: boolean;
  likeness_watermark_always?: boolean;
  vyra_dev_mode: boolean; assist: boolean; streaming_available?: boolean;
  voices?: AccentVoice[]; voice_price_per_minute?: number; voice_max_seconds?: number;
};
export type OverlayConfig = {
  visible: boolean;
  title: string;
  sub: string;
  logoImg?: HTMLImageElement | null;
};

export type VoiceRigHandle = {
  setEffect(id: string): void;
  setMuted(on: boolean): void;
  setMonitor(on: boolean): void;
  setDelay(ms: number): void;
  level(): number;
  track(): MediaStreamTrack;
  resume(): Promise<void>;
  close(): void;
};

export type SceneRule = {
  id: string;
  trigger: string;
  action: string;
  undo: boolean;
  enabled: boolean;
};

declare global {
  interface Window {
    FalLucy?: { connect(stream: MediaStream, opts: Record<string, unknown>): Promise<Session> };
    MessagePack?: unknown;
    Mediabunny?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    VyraVoice?: {
      VOICES: { id: string; name: string; note: string }[];
      create(mic: MediaStream, shared?: AudioContext): Promise<VoiceRigHandle>;
      LagMeter: new (cam: HTMLVideoElement, ai: HTMLVideoElement) => {
        start(): void;
        stop(): void;
        estimate(): { ms: number; confidence: number } | null;
      };
    };
    VyraScenes?: {
      TRIGGERS: { id: string; name: string }[];
      SceneRunner: new (video: HTMLVideoElement, onFire: (rule: SceneRule, on: boolean) => void) => {
        setRules(rules: SceneRule[]): void;
        start(): Promise<void>;
        stop(): void;
      };
      Commands: new (onCommand: (cmd: string) => void, onState: (state: string) => void) => {
        supported: boolean;
        setMode(mode: "off" | "hold" | "handsfree"): void;
        press(): void;
        release(): void;
        state(): string;
      };
    };
    __VYRA_LIVE_OUTPUT_STREAM__?: MediaStream | null;
    VyraVirtualCam?: {
      VYRA_CAM_ID: string;
      VYRA_MIC_ID: string;
      publishStream?(stream: MediaStream, width?: number, height?: number, lookLabel?: string): void;
      stop?(): void;
    };
  }
}

const loaded = new Map<string, Promise<void>>();
export function loadScript(src: string) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const el = Object.assign(document.createElement("script"), { src, async: true });
      el.onload = () => resolve();
      el.onerror = () => { loaded.delete(src); reject(new Error("A part of the live studio didn't load. Refresh the page.")); };
      document.head.append(el);
    }));
  }
  return loaded.get(src)!;
}

export async function prepare(_provider = "fal") {
  await loadScript("/assets/vendor/msgpack.js");
  await loadScript("/assets/fal-live.js");
}

export const getStatus = () => api<LiveStatus>("/api/live/status");
export type Meter = { session_id: string; state: string; elapsed: number; paid_seconds: number; balance: number; stop?: boolean; low_balance?: boolean };
type Token = { token?: string; url?: string; api_key?: string; meter?: Meter };

export async function createLookPrompt(idea: string, base?: string): Promise<{ name: string; note: string; prompt: string }> {
  return api<{ name: string; note: string; prompt: string }>("/api/assist/look", { idea, ...(base ? { base } : {}) });
}

// The prompt that turns the person on camera into the character in the reference photo.
export function characterPrompt(description: string) {
  const start = "Replace the person with the person in the reference image";
  const end = ". Match face shape, skin tone and hairstyle. Photorealistic, natural skin texture with pores; no airbrushed or plastic skin. Follow the original movement, expressions and head pose. Keep the background, room, lighting and camera framing exactly as in the input video; change only the person.";
  const details = description.replace(/\s+/g, " ").trim().replace(/\.+$/, "").slice(0, 399 - start.length - end.length - 2);
  return start + (details ? `: ${details}` : "") + end;
}

// Video models drift a person's identity (skin tone, face, hair) when restyling clothes or scenes. Every text look
// keeps the person as they are unless it asks to change them; a reference photo is a deliberate character swap.
export const KEEP_IDENTITY = "Keep the person's own face, skin tone, facial features, hair and expressions exactly as they are.";
const KEEP_FACE = "Keep the person's own face, skin tone, facial features and expressions exactly as they are.";
const CHANGES_FACE = /(face|skin|complexion|aged?|ageing|aging|older|younger|elderly|child|makeup|make-up|beard|moustache|mustache|tattoos?|become someone|turn (them|the person) into|replace the person)/i;
const CHANGES_HAIR = /(hair|hairstyle|haircut|wig|braids?|bob|curls|bald)/i;
export function guardPrompt(prompt: string, hasImage: boolean) {
  const text = prompt.trim();
  if (!text || hasImage || CHANGES_FACE.test(text) || text.includes(KEEP_FACE) || text.includes(KEEP_IDENTITY)) return text;
  return `${text} ${CHANGES_HAIR.test(text) ? KEEP_FACE : KEEP_IDENTITY}`;
}

/** Connects one live session. `billing.id` is filled by the first token and reused by reconnects. */
export async function connect(opts: {
  stream: MediaStream; provider: string; model: string; state: LiveState; signal: AbortSignal;
  onRemote: (stream: MediaStream) => void; onRetry: (attempt: number, of: number) => void; billing: { id: string | null; onMeter: (m: Meter) => void };
}): Promise<Session | null> {
  const { stream, provider, state, signal, onRemote, onRetry, billing } = opts;
  await prepare(provider);
  const mint = async () => {
    const token = await api<Token>("/api/live/token", { provider, ...(billing.id ? { session_id: billing.id } : {}) });
    if (token.meter) { billing.id = token.meter.session_id; billing.onMeter(token.meter); }
    return token;
  };
  const initialState = { ...(state.image ? { image: state.image } : {}), prompt: { text: guardPrompt(state.prompt, Boolean(state.image)), enhance: state.enhance } };

  // fal keeps its single live slot for up to two minutes after a session ends, so "busy" is retried.
  const RETRIES = 7;
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) return null;
    const token = await mint();
    try {
      const session = await window.FalLucy!.connect(stream, { url: token.url, token: token.token, initialState, onRemoteStream: onRemote, signal });
      if (!session) return session;
      const set = session.set.bind(session);
      session.set = (next) => set({ ...next, prompt: guardPrompt(next.prompt, Boolean(next.image)) });
      return session;
    } catch (error) {
      if (signal.aborted) return null;
      const busy = (error as { code?: string }).code === "busy";
      // fal's own words, so a "busy" can be told apart from capacity or account problems.
      const said = (error as { falMessage?: string }).falMessage;
      console.warn(`[VYRANI] fal refused the live session (attempt ${attempt + 1}):`, said || (error as Error).message);
      if (!busy || attempt >= RETRIES) {
        if (busy && said) throw new Error(`fal is still refusing the session: "${said}". Try again in a few minutes.`);
        throw error;
      }
      onRetry(attempt + 1, RETRIES);
      const wait = Math.min(20000, 5000 * 2 ** attempt);
      const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), wait);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(false); }, { once: true });
      });
      if (!ok) return null;
    }
  }
}

export const heartbeat = (id: string) => api<Meter>(`/api/live/meter/${encodeURIComponent(id)}/heartbeat`, {});
export const endMeter = (id: string) => api<Meter>(`/api/live/meter/${encodeURIComponent(id)}/end`, {}).catch(() => null);
export const endMeterOnUnload = (id: string) => navigator.sendBeacon?.(`/api/live/meter/${encodeURIComponent(id)}/end`);

export async function describePhoto(file: Blob): Promise<string> {
  const form = new FormData();
  form.append("image", file, "character.jpg");
  const response = await fetch("/api/assist/describe", { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(typeof payload.detail === "string" ? payload.detail : "Couldn't read that photo.", response.status);
  return String(payload.description || "");
}

/** Crops a photo to cover the camera's shape, the way the engine expects its reference image. */
export async function fitToCamera(file: Blob, aspect: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = aspect >= 1 ? 1280 : 720;
  canvas.height = Math.round(canvas.width / aspect);
  const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
  const w = bitmap.width * scale, h = bitmap.height * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2.6, w, h); // bias up: keep the face
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't prepare that photo."))), "image/jpeg", 0.9));
}

// ---------- recording ----------
const PROVENANCE = "Made with VYRANI AI. This video was transformed by AI and may show synthetic or altered people, voices or scenes.";

export function recorderType(withAudio = true) {
  const types = withAudio
    ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,opus", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  return types.find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
}

function drawBroadcastOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, overlay?: OverlayConfig) {
  if (!overlay?.visible || !(overlay.title || overlay.sub || overlay.logoImg)) return;
  const k = h / 720;
  const titleSize = Math.round(28 * k);
  const subSize = Math.round(14 * k);
  const pad = Math.round(14 * k);
  const bar = Math.max(3, Math.round(6 * k));
  const sub = (overlay.sub || "").toUpperCase();
  ctx.font = `700 ${titleSize}px Chillax, "Segoe UI", system-ui, sans-serif`;
  const titleWidth = overlay.title ? ctx.measureText(overlay.title).width : 0;
  ctx.font = `600 ${subSize}px ui-monospace, Consolas, monospace`;
  const subWidth = sub ? ctx.measureText(sub).width : 0;
  const img = overlay.logoImg;
  const logoH = img && img.complete && img.naturalHeight ? Math.round(46 * k) : 0;
  const logoW = logoH && img ? (img.naturalWidth / img.naturalHeight) * logoH : 0;
  const textH = (overlay.title ? titleSize * 1.2 : 0) + (sub ? subSize * 1.5 : 0);
  const boxH = Math.max(logoH + pad, textH + pad * 1.3);
  const boxW = bar + pad + (logoW ? logoW + pad : 0) + Math.max(titleWidth, subWidth) + pad * 1.2;
  const x = Math.round(w * 0.04);
  const y = Math.round(h * 0.91 - boxH);
  ctx.fillStyle = "rgba(9, 9, 11, 0.88)";
  ctx.fillRect(x, y, boxW, boxH);
  ctx.fillStyle = "#ff6b2b";
  ctx.fillRect(x, y, bar, boxH);
  let cx = x + bar + pad;
  if (logoW && img) {
    ctx.drawImage(img, cx, y + (boxH - logoH) / 2, logoW, logoH);
    cx += logoW + pad;
  }
  let cy = y + (boxH - textH) / 2;
  ctx.textBaseline = "top";
  if (overlay.title) {
    ctx.fillStyle = "#f4f4f5";
    ctx.font = `700 ${titleSize}px Chillax, "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(overlay.title, cx, cy);
    cy += titleSize * 1.2;
  }
  if (sub) {
    ctx.fillStyle = "#ff6b2b";
    ctx.font = `600 ${subSize}px ui-monospace, Consolas, monospace`;
    ctx.fillText(sub, cx, cy + subSize * 0.25);
  }
  ctx.textBaseline = "alphabetic";
}

/** Master Output Compositor: draws the AI video (or camera fallback), broadcast overlay, and VYRANI · AI watermark. */
/** Freezes the last AI frame, dimmed, with a "Be right back" card: shown to calls and streams after an unplanned stop. */
export function holdCard(video: HTMLVideoElement | null, title = "Be right back", sub = "VYRANI") {
  const canvas = Object.assign(document.createElement("canvas"), { width: 1280, height: 720 });
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#09090b";
  ctx.fillRect(0, 0, 1280, 720);
  if (video && video.videoWidth) {
    ctx.filter = "blur(18px) brightness(0.45)";
    ctx.drawImage(video, -40, -40, 1360, 800);
    ctx.filter = "none";
  }
  ctx.fillStyle = "rgba(9, 9, 11, 0.55)";
  ctx.fillRect(0, 0, 1280, 720);
  ctx.textAlign = "center";
  ctx.fillStyle = "#f4f4f5";
  ctx.font = "600 64px Chillax, system-ui, sans-serif";
  ctx.fillText(title, 640, 370);
  ctx.fillStyle = "#ff6b2b";
  ctx.font = "600 24px Chillax, system-ui, sans-serif";
  ctx.fillText(sub, 640, 420);
  return canvas;
}

export function compositor(
  video: HTMLVideoElement,
  opts: boolean | { label: boolean; compactLabel?: boolean; getOverlay?: () => OverlayConfig | undefined; getHold?: () => CanvasImageSource | null }
) {
  const getOpts = typeof opts === "boolean" ? { label: opts, compactLabel: false } : opts;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext("2d")!;
  let running = true;
  const draw = () => {
    if (!running) return;
    if (video.videoWidth && canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    // A "Be right back" card replaces the picture after an unplanned stop, so viewers never see a frozen or real face.
    const hold = "getHold" in getOpts ? getOpts.getHold?.() : null;
    ctx.drawImage(hold || video, 0, 0, canvas.width, canvas.height);
    const ov = getOpts.getOverlay?.();
    if (ov) drawBroadcastOverlay(ctx, canvas.width, canvas.height, ov);
    if (getOpts.label) {
      const s = canvas.height / 720;
      const compact = Boolean(getOpts.compactLabel);
      const fontSize = Math.round((compact ? 12 : 18) * s);
      ctx.font = `600 ${fontSize}px Chillax, sans-serif`;
      const text = "VYRANI · AI";
      const pad = (compact ? 6 : 10) * s;
      const w = ctx.measureText(text).width + pad * 2;
      const h = (compact ? 22 : 30) * s;
      const margin = (compact ? 12 : 16) * s;
      ctx.fillStyle = compact ? "rgba(0,0,0,0.42)" : "rgba(0,0,0,0.55)";
      ctx.fillRect(canvas.width - w - margin, canvas.height - h - margin, w, h);
      ctx.fillStyle = compact ? "rgba(255,255,255,0.85)" : "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(text, canvas.width - w - margin + pad, canvas.height - h / 2 - margin);
    }
    requestAnimationFrame(draw);
  };
  draw();
  return { canvas, stream: canvas.captureStream(30), stop: () => { running = false; } };
}

function encodeWav16k(samples: Float32Array, inputRate: number): ArrayBuffer {
  const targetRate = 16000;
  const ratio = inputRate / targetRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const buffer = new ArrayBuffer(44 + outLength * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + outLength * 2, true);
  writeStr(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, outLength * 2, true);
  for (let i = 0; i < outLength; i++) {
    const idx = Math.min(samples.length - 1, Math.floor(i * ratio));
    const v = Math.max(-1, Math.min(1, samples[idx]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return buffer;
}

/** Replaces the recorded audio track in `blob` with an ElevenLabs AI accent voice via `/api/voice/convert`. */
export async function withAiVoice(blob: Blob, voiceId: string, maxSeconds = 600): Promise<Blob> {
  await loadScript("/assets/vendor/mediabunny.js");
  const M = window.Mediabunny;
  const input = new M.Input({ source: new M.BlobSource(blob), formats: M.ALL_FORMATS });
  const [videoTrack, audioTrack] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
  if (!videoTrack || !audioTrack) throw new Error("This recording has no voice track to convert.");
  const duration = await input.computeDuration();
  if (maxSeconds && duration > maxSeconds + 10) {
    throw new Error(`Accent voices work on recordings up to ${Math.round(maxSeconds / 60)} minutes.`);
  }
  const rate = audioTrack.sampleRate;
  const mono = new Float32Array(Math.max(1, Math.ceil(duration * rate)));
  for await (const { buffer, timestamp } of new M.AudioBufferSink(audioTrack).buffers()) {
    const at = Math.max(0, Math.round(timestamp * rate));
    const data = buffer.getChannelData(0);
    mono.set(data.subarray(0, Math.max(0, Math.min(data.length, mono.length - at))), at);
  }
  const form = new FormData();
  form.append("audio", new Blob([encodeWav16k(mono, rate)], { type: "audio/wav" }), "voice.wav");
  form.append("voice", voiceId);
  const response = await fetch("/api/voice/convert", { method: "POST", body: form, signal: AbortSignal.timeout(240000) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(typeof payload.detail === "string" ? payload.detail : "The AI voice could not be applied.");
  }
  const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await response.arrayBuffer());
  const voiceBuf = new AudioBuffer({ length: Math.max(1, Math.round(duration * decoded.sampleRate)), numberOfChannels: 1, sampleRate: decoded.sampleRate });
  voiceBuf.copyToChannel(decoded.getChannelData(0).subarray(0, voiceBuf.length), 0);
  const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: "in-memory" }), target: new M.BufferTarget() });
  const videoSource = new M.EncodedVideoPacketSource(videoTrack.codec);
  output.addVideoTrack(videoSource, { rotation: videoTrack.rotation });
  const codec = (await M.canEncodeAudio("aac")) ? "aac" : "opus";
  const audioSource = new M.AudioBufferSource({ codec, quality: M.QUALITY_HIGH });
  output.addAudioTrack(audioSource);
  await output.start();
  const config = await videoTrack.getDecoderConfig();
  let first = true;
  for await (const packet of new M.EncodedPacketSink(videoTrack).packets()) {
    await videoSource.add(packet, first ? { decoderConfig: config } : undefined);
    first = false;
  }
  await audioSource.add(voiceBuf);
  videoSource.close();
  audioSource.close();
  await output.finalize();
  return new Blob([output.target.buffer], { type: "video/mp4" });
}

/** Adds VYRANI's provenance tag to an MP4 (skipped only in explicit dev mode). Best effort. */
export async function withProvenance(blob: Blob): Promise<Blob> {
  await loadScript("/assets/vendor/mediabunny.js");
  const M = window.Mediabunny;
  const input = new M.Input({ source: new M.BlobSource(blob), formats: M.ALL_FORMATS });
  const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: "in-memory" }), target: new M.BufferTarget() });
  const conversion = await M.Conversion.init({ input, output, showWarnings: false,
    tags: { title: "VYRANI AI recording", comment: PROVENANCE, description: PROVENANCE, date: new Date() } });
  if (!conversion.isValid) throw new Error("This recording could not be tagged.");
  await conversion.execute();
  return new Blob([output.target.buffer], { type: "video/mp4" });
}

// ---------- livestream (browser → VYRANI relay → the user's RTMP/RTMPS destination) ----------
export const PLATFORMS = [
  { id: "youtube", name: "YouTube", url: "rtmp://a.rtmp.youtube.com/live2", help: "YouTube Studio → Go live → Stream key" },
  { id: "twitch", name: "Twitch", url: "rtmp://live.twitch.tv/app", help: "Twitch → Creator dashboard → Settings → Stream → Primary stream key" },
  { id: "facebook", name: "Facebook", url: "rtmps://live-api-s.facebook.com:443/rtmp/", help: "Facebook → Live video → Streaming software → Stream key" },
  { id: "custom", name: "Other", url: "", help: "Any RTMP or RTMPS server URL and its key" },
];

export type StreamHandle = { stop: () => Promise<void> };

/** Sends `video` (+ optional `audio`) to the user's destination. Calls onEnd with a message if it drops. */
export async function startStream(opts: { video: MediaStream; audio?: MediaStreamTrack | null; url: string; key: string; onEnd: (message?: string) => void }): Promise<StreamHandle> {
  // H.264 from the browser lets the server pass video straight through instead of re-encoding it (Chrome, Edge).
  // Safari (iPhone, iPad, Mac) records only MP4, which is H.264 too; the server reads either container.
  const mp4 = !["video/webm"].some((t) => MediaRecorder.isTypeSupported(t))
    ? ["video/mp4;codecs=avc1,mp4a", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || "" : "";
  const h264 = mp4 || ["video/webm;codecs=h264,opus", "video/webm;codecs=avc1,opus"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  const mime = h264 || ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  const { ticket } = await api<{ ticket: string }>("/api/live/stream/ticket", { url: opts.url, key: opts.key });
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live/stream/${encodeURIComponent(ticket)}?${new URLSearchParams({ ...(h264 ? { video: "h264" } : {}), ...(mp4 ? { container: "mp4" } : {}) })}`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The streaming relay didn't answer. Try again.")), 15000);
    ws.onmessage = (e) => { try { if (JSON.parse(e.data).type === "ready") { clearTimeout(timer); resolve(); } } catch { /* binary or junk */ } };
    ws.onclose = (e) => { clearTimeout(timer); reject(new Error(e.reason || "Couldn't start the stream.")); };
  });
  const tracks = [...opts.video.getVideoTracks(), ...(opts.audio ? [opts.audio] : [])];
  // A keyframe every 2 s lets viewers who join mid-stream see video quickly (ignored by browsers without the option).
  const recorder = new MediaRecorder(new MediaStream(tracks), mime
    ? { mimeType: mime, videoBitsPerSecond: 3_500_000, videoKeyFrameIntervalDuration: 2000 } as MediaRecorderOptions : undefined);
  let queue = Promise.resolve();
  let ended = false;
  const finish = (message?: string) => { if (ended) return; ended = true; try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* stopped */ } opts.onEnd(message); };
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    queue = queue.then(async () => { if (ws.readyState === WebSocket.OPEN) ws.send(await e.data.arrayBuffer()); });
  };
  ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === "error") { finish(m.message); ws.close(); } } catch { /* ignore */ } };
  ws.onclose = (e) => finish(e.code === 1000 ? undefined : e.reason || "The stream connection dropped.");
  recorder.start(500);
  return {
    async stop() {
      if (ended) return;
      ended = true;
      try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* stopped */ }
      await queue;
      if (ws.readyState === WebSocket.OPEN) { ws.send("end"); setTimeout(() => ws.close(1000), 1500); }
      opts.onEnd();
    },
  };
}
