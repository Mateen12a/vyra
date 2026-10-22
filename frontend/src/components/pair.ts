// A "pair" is one video holding two views side by side: the camera on the left half, the AI result on the right.
// Drawing both halves from the same frame keeps them perfectly in step on every device (two separate videos drift,
// and correcting them makes phones stutter). Until the video is playing, the matching still is drawn instead, so a
// demo is never blank on a slow connection or when a phone blocks autoplay (e.g. iPhone Low Power Mode).
const DIR = "/assets/site/looks/";

export type PairFrame = { src: CanvasImageSource; half: number; height: number };

export class PairPlayer {
  readonly video: HTMLVideoElement;
  private readonly still = new Image();
  private stillReady = false;
  private loops = 0;
  private last = 0;
  private restart: () => void = () => {};
  onLoop?: (loops: number) => void;

  constructor(host: HTMLElement, id: string, play: boolean) {
    this.still.decoding = "async";
    this.still.onload = () => { this.stillReady = true; };
    this.still.src = `${DIR}${id}.jpg`;
    const v = document.createElement("video");
    Object.assign(v, { muted: true, loop: true, playsInline: true, preload: "auto" });
    v.setAttribute("muted", ""); v.setAttribute("playsinline", ""); v.setAttribute("aria-hidden", "true");
    v.className = "pair-src";
    v.src = `${DIR}${id}.mp4`;
    // Counts loops (a looping video never fires "ended").
    v.addEventListener("timeupdate", () => {
      if (v.currentTime + 0.2 < this.last) { this.loops++; this.onLoop?.(this.loops); }
      this.last = v.currentTime;
    });
    // Some mobile browsers don't honour "loop" reliably and freeze on the last frame: restart by hand as well.
    let restarting = false;
    const restart = () => {
      if (restarting) return; // one restart per loop, even while the seek back to the start is still running
      restarting = true;
      v.currentTime = 0; v.play().catch(() => {}); this.loops++; this.onLoop?.(this.loops); this.last = 0;
    };
    v.addEventListener("seeked", () => { restarting = false; });
    v.addEventListener("ended", restart);
    this.restart = restart;
    host.appendChild(v);
    this.video = v;
    if (play) v.play().catch(() => { /* autoplay blocked: the still is drawn instead */ });
  }

  /** The frame to draw now: the live video once it is really playing, otherwise the still. */
  frame(): PairFrame | null {
    const v = this.video;
    if (!v.paused && v.duration && (v.ended || v.currentTime >= v.duration - 0.04)) this.restart();
    if (v.readyState >= 2 && v.videoWidth && !v.paused) return { src: v, half: v.videoWidth / 2, height: v.videoHeight };
    if (this.stillReady) return { src: this.still, half: this.still.naturalWidth / 2, height: this.still.naturalHeight };
    if (v.readyState >= 2 && v.videoWidth) return { src: v, half: v.videoWidth / 2, height: v.videoHeight };
    return null;
  }

  /** Retries playback after a user gesture (some browsers only allow video to start after one). */
  resume() { if (this.video.paused) this.video.play().catch(() => {}); }

  destroy() { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); this.video.remove(); }
}

/** Draws one half of a pair frame into a rectangle, cropped to cover it ("object-fit: cover"). */
export function drawHalf(ctx: CanvasRenderingContext2D, f: PairFrame, side: 0 | 1, x: number, y: number, w: number, h: number,
  focus = { x: 0.5, y: 0.45 }) {
  const scale = Math.max(w / f.half, h / f.height);
  const sw = w / scale, sh = h / scale;
  const sx = Math.min(f.half - sw, Math.max(0, focus.x * f.half - sw / 2));
  const sy = Math.min(f.height - sh, Math.max(0, focus.y * f.height - sh / 2));
  ctx.drawImage(f.src, side * f.half + sx, sy, sw, sh, x, y, w, h);
}
