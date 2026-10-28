// On-device vision for the studio (MediaPipe, free and private: nothing leaves the computer).
//  - Face check: how many faces are in view, how big, how well lit, so the studio can warn before and during live.
//  - Background: cuts the person out of the camera and puts a blur or a picture behind them, like Google Meet.
//    The result is a new video track that is what the AI (and so the call) receives.
import { every } from "../lib/ticker";
import { loadScript } from "./engine";

const BASE = "/assets/vendor/mediapipe";

type Box = { originX: number; originY: number; width: number; height: number };
type FaceDetector = { detectForVideo(video: HTMLVideoElement, ts: number): { detections: { boundingBox?: Box }[] }; close(): void };
type Mask = { width: number; height: number; getAsFloat32Array(): Float32Array; close(): void };
type Segmenter = { segmentForVideo(video: HTMLVideoElement, ts: number): { confidenceMasks?: Mask[]; close?(): void }; close(): void };
type MPVision = {
  FilesetResolver: { forVisionTasks(path: string): Promise<unknown> };
  FaceDetector: { createFromOptions(fs: unknown, opts: unknown): Promise<FaceDetector> };
  ImageSegmenter: { createFromOptions(fs: unknown, opts: unknown): Promise<Segmenter> };
};

let fileset: Promise<{ V: MPVision; fs: unknown }> | null = null;
function vision() {
  fileset ||= (async () => {
    await loadScript(`${BASE}/vision.js`);
    const V = (window as unknown as { MPVision: MPVision }).MPVision;
    return { V, fs: await V.FilesetResolver.forVisionTasks(`${BASE}/wasm`) };
  })();
  fileset.catch(() => { fileset = null; }); // a failed load can be retried later
  return fileset;
}

let faceDetector: Promise<FaceDetector> | null = null;
const getFaceDetector = () => faceDetector ||= vision().then(({ V, fs }) => V.FaceDetector.createFromOptions(fs, {
  baseOptions: { modelAssetPath: `${BASE}/models/blaze_face_short_range.tflite`, delegate: "CPU" }, runningMode: "VIDEO", minDetectionConfidence: 0.55,
}));

let segmenter: Promise<Segmenter> | null = null;
const getSegmenter = () => segmenter ||= vision().then(({ V, fs }) => V.ImageSegmenter.createFromOptions(fs, {
  baseOptions: { modelAssetPath: `${BASE}/models/selfie_segmenter.tflite`, delegate: "CPU" }, runningMode: "VIDEO",
  outputConfidenceMasks: true, outputCategoryMask: false,
}));

// MediaPipe's VIDEO mode needs strictly increasing timestamps, shared by every task on the same video.
let lastTs = 0;
const nextTs = () => (lastTs = Math.max(lastTs + 1, Math.round(performance.now())));

export type FaceCheck = { faces: number; size: number; brightness: number };
export type FaceIssue = "none" | "many" | "small" | "dark" | null;

/** One look at the camera: number of faces, the largest face's width as a share of the frame, and its brightness (0-255). */
export async function checkFace(video: HTMLVideoElement): Promise<FaceCheck | null> {
  if (!video.videoWidth || video.readyState < 2) return null;
  const detector = await getFaceDetector();
  const found = detector.detectForVideo(video, nextTs()).detections.map((d) => d.boundingBox).filter((b): b is Box => Boolean(b));
  const biggest = found.sort((a, b) => b.width - a.width)[0];
  return { faces: found.length, size: biggest ? biggest.width / video.videoWidth : 0, brightness: biggest ? brightness(video, biggest) : 0 };
}

function brightness(video: HTMLVideoElement, box: Box) {
  const c = Object.assign(document.createElement("canvas"), { width: 32, height: 32 });
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, box.originX, box.originY, box.width, box.height, 0, 0, 32, 32);
  const px = ctx.getImageData(0, 0, 32, 32).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  return sum / (px.length / 4);
}

/** The one thing worth telling the person, most important first. */
export function faceIssue(check: FaceCheck | null): FaceIssue {
  if (!check) return null;
  if (check.faces === 0) return "none";
  if (check.faces > 1) return "many";
  if (check.size < 0.12) return "small";
  if (check.brightness < 60) return "dark";
  return null;
}

export const FACE_TIPS: Record<Exclude<FaceIssue, null>, string> = {
  none: "We can't see a face. Face the camera so the AI look has someone to follow.",
  many: "More than one person is in view. Everyone in the picture will change.",
  small: "You're far from the camera. Move closer so your face fills more of the picture.",
  dark: "Your face is dimly lit. Face a window or lamp for a more realistic result.",
};

// ---------- Backgrounds ----------

export type Background = { id: string; name: string; kind: "none" | "blur" | "image"; src?: string };
export const BACKGROUNDS: Background[] = [
  { id: "none", name: "None", kind: "none" },
  { id: "blur", name: "Blur", kind: "blur" },
  { id: "office", name: "Soft grey", kind: "image", src: "/assets/site/backgrounds/office.jpg" },
  { id: "studio", name: "Warm", kind: "image", src: "/assets/site/backgrounds/studio.jpg" },
  { id: "lounge", name: "Lounge", kind: "image", src: "/assets/site/backgrounds/lounge.jpg" },
  { id: "night", name: "Night", kind: "image", src: "/assets/site/backgrounds/night.jpg" },
]

/**
 * Draws the camera with its background replaced into a canvas and exposes that as a video track. Runs on a worker
 * timer, so it keeps going while the studio tab is in the background (the call tab is usually the one in front).
 */
export class BackgroundRig {
  readonly canvas = document.createElement("canvas");
  readonly track: MediaStreamTrack;
  private readonly person = document.createElement("canvas");
  private readonly mask = document.createElement("canvas");
  private readonly small = Object.assign(document.createElement("canvas"), { width: 96, height: 54 }); // for a cheap blur
  private image: HTMLImageElement | null = null;
  private kind: Background["kind"] = "none";
  private stopTick: (() => void) | null = null;
  private busy = false;
  private segAt = 0;
  private segEvery = 66;
  frames = 0;

  constructor(private readonly video: HTMLVideoElement, fps = 15) {
    this.canvas.width = 1280; this.canvas.height = 720;
    this.track = this.canvas.captureStream(fps).getVideoTracks()[0];
    this.stopTick = every(Math.round(1000 / fps), () => { this.draw().catch(() => {}); });
  }

  /** Switches the background; resolves once a picture background has loaded. */
  async set(bg: Background) {
    if (bg.kind === "image" && bg.src) {
      const img = new Image();
      img.src = bg.src;
      await img.decode();
      this.image = img;
    }
    this.kind = bg.kind;
    await getSegmenter(); // load the model before the first frame needs it
  }

  private async draw() {
    const v = this.video;
    if (this.busy || !v.videoWidth || v.readyState < 2) return;
    this.busy = true;
    try {
      // At most 960 px wide: what the AI receives anyway, and far less work per frame than full 720p/1080p.
      const scale = Math.min(1, 960 / v.videoWidth);
      const W = Math.round(v.videoWidth * scale), H = Math.round(v.videoHeight * scale);
      if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
      const ctx = this.canvas.getContext("2d")!;
      if (this.kind === "none") { ctx.drawImage(v, 0, 0, W, H); this.frames++; return; }
      // The cut-out is the costly step. It runs only as often as this computer manages it in about a third of
      // its time; frames in between reuse the last mask, so a slow laptop stays responsive.
      const now = performance.now();
      if (now - this.segAt >= this.segEvery || !this.mask.width) {
        const segmenter = await getSegmenter();
        const t = performance.now();
        const seg = segmenter.segmentForVideo(v, nextTs());
        const m = seg.confidenceMasks?.[0];
        if (m) {
          // The mask as an alpha image: confident person pixels opaque, background transparent, a soft edge between.
          const mw = m.width, mh = m.height, conf = m.getAsFloat32Array();
          if (this.mask.width !== mw || this.mask.height !== mh) { this.mask.width = mw; this.mask.height = mh; }
          const mctx = this.mask.getContext("2d")!;
          const data = mctx.createImageData(mw, mh);
          for (let i = 0; i < conf.length; i++) data.data[i * 4 + 3] = Math.min(1, Math.max(0, (conf[i] - 0.35) / 0.4)) * 255;
          mctx.putImageData(data, 0, 0);
          m.close();
        }
        seg.close?.();
        this.segAt = now;
        this.segEvery = Math.min(500, Math.max(66, (performance.now() - t) * 3));
      }
      if (!this.mask.width) { ctx.drawImage(v, 0, 0, W, H); return; }

      // The person: the camera frame kept only where the mask is.
      if (this.person.width !== W || this.person.height !== H) { this.person.width = W; this.person.height = H; }
      const pctx = this.person.getContext("2d")!;
      pctx.globalCompositeOperation = "copy";
      pctx.imageSmoothingEnabled = true; // scaling the small mask up softens the cut-out edge
      pctx.drawImage(this.mask, 0, 0, W, H);
      pctx.globalCompositeOperation = "source-in";
      pctx.drawImage(v, 0, 0, W, H);
      pctx.globalCompositeOperation = "source-over";

      // The background, then the person on top.
      if (this.kind === "blur") {
        // Shrinking the frame to a thumbnail and stretching it back blurs it for a fraction of a blur filter's cost.
        const sctx = this.small.getContext("2d")!;
        sctx.drawImage(v, 0, 0, this.small.width, this.small.height);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        ctx.drawImage(this.small, 0, 0, W, H);
      } else if (this.image) {
        const img = this.image, s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        const w = img.naturalWidth * s, h = img.naturalHeight * s;
        ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      }
      ctx.drawImage(this.person, 0, 0);
      this.frames++;
    } finally {
      this.busy = false;
    }
  }

  stop() { this.stopTick?.(); this.stopTick = null; this.track.stop(); }
}
