import { useEffect, useRef, useState, type ReactNode } from "react";
import { PairPlayer } from "./pair";

// The landing hero: Mary's real camera clip and the same clip as Tom play in step on one canvas. On arrival an orange
// pixel mesh scans her face and a few pixels already turn (alive before any scroll); scrolling then spreads Tom outward
// from the face, block by block, with a glowing edge. Both views come from one paired video (camera | result), so they
// never drift; until it plays, the paired still is used and the effect still works. The people are AI-generated.
const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
const FACE = { x: 0.5, y: 0.4 }; // face centre in the source frame (0-1)
const ORANGE = "255, 107, 43";

const reduce = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };

export function TransformHero({ children, onProgress }: { children: (p: number) => ReactNode; onProgress?: (p: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [scrollP, setScrollP] = useState(reduce() ? 1 : 0);
  const scrollRef = useRef(scrollP);

  // Scroll progress through the pinned hero (0 at the top, 1 when the track has been scrolled past).
  useEffect(() => {
    if (reduce()) return;
    const onScroll = () => {
      const el = trackRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const p = clamp(-r.top / Math.max(1, r.height - innerHeight));
      scrollRef.current = p;
      setScrollP(p);
      onProgress?.(p);
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    return () => { removeEventListener("scroll", onScroll); removeEventListener("resize", onScroll); };
  }, [onProgress]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0, start = 0, alive = true;
    const still = reduce();
    const player = new PairPlayer(hostRef.current!, "pair-a", !still);
    const wake = () => { if (!still) player.resume(); };
    addEventListener("touchstart", wake, { once: true, passive: true });
    addEventListener("click", wake, { once: true });

    const size = () => {
      const dpr = Math.min(1.5, devicePixelRatio || 1);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
    };
    size();
    addEventListener("resize", size);

    const draw = (now: number) => {
      if (!alive) return;
      raf = requestAnimationFrame(draw);
      const f = player.frame();
      if (!f) return;
      if (!start) start = now;
      const t = (now - start) / 1000;
      const W = canvas.width, H = canvas.height, vw = f.half, vh = f.height;
      // "cover" crop that keeps the face in view on tall phone screens
      const scale = Math.max(W / vw, H / vh);
      const dw = vw * scale, dh = vh * scale;
      const dx = clamp(W / 2 - FACE.x * dw, W - dw, 0), dy = clamp(H * 0.42 - FACE.y * dh, H - dh, 0);
      const fx = dx + FACE.x * dw, fy = dy + FACE.y * dh;

      // Progress: the scroll, plus an arrival teaser so something changes before the visitor scrolls.
      const teaser = still ? 1 : smooth(0.6, 2.4, t) * (0.16 + 0.04 * Math.sin(t * 1.3));
      const p = still ? 1 : Math.max(scrollRef.current * 1.12, teaser);

      ctx.drawImage(f.src, 0, 0, vw, vh, dx, dy, dw, dh); // left half: the camera
      const cell = Math.max(12, Math.round(Math.min(W, H) / 26));
      const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
      const reach = Math.hypot(Math.max(fx, W - fx), Math.max(fy, H - fy));
      const revealed = new Path2D();
      const edges: [number, number, number][] = [], mesh: [number, number, number][] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * cell, y = r * cell;
          const d = Math.hypot(x + cell / 2 - fx, y + cell / 2 - fy) / reach;
          const order = 0.72 * d + 0.28 * (BAYER[((r & 7) << 3) | (c & 7)] / 64);
          if (order < p) revealed.rect(x, y, cell, cell);
          else if (order < p + 0.07) edges.push([x, y, 1 - (order - p) / 0.07]);
          else if (d < 0.2 && p < 0.95) mesh.push([x, y, d]);
        }
      }
      ctx.save(); ctx.clip(revealed); ctx.drawImage(f.src, vw, 0, vw, vh, dx, dy, dw, dh); ctx.restore(); // right half: Tom

      // The glowing edge where pixels are changing right now.
      for (const [x, y, a] of edges) {
        ctx.fillStyle = `rgba(${ORANGE}, ${0.18 + 0.32 * a})`;
        ctx.fillRect(x, y, cell, cell);
      }
      // The scanning mesh over the face: pixels flicker in dither order, a scan line sweeps down.
      if (!still) {
        const lineY = fy - reach * 0.2 + ((t * 0.35) % 1) * reach * 0.4;
        for (const [x, y, d] of mesh) {
          const phase = BAYER[(((y / cell) & 7) << 3) | ((x / cell) & 7)] / 64;
          const flicker = Math.max(0, Math.sin(t * 2.4 + phase * Math.PI * 2));
          const near = Math.max(0, 1 - Math.abs(y + cell / 2 - lineY) / (cell * 2.5));
          const a = (0.08 + 0.32 * flicker * (1 - d * 3)) * (1 - p) + 0.5 * near * (1 - p);
          if (a < 0.04) continue;
          ctx.strokeStyle = `rgba(${ORANGE}, ${a})`;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    // Pause the video once the hero is scrolled past; resume when it's back.
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) wake(); else player.video.pause(); });
    io.observe(canvas);
    return () => {
      io.disconnect();
      alive = false; cancelAnimationFrame(raf); removeEventListener("resize", size); player.destroy();
      removeEventListener("touchstart", wake); removeEventListener("click", wake);
    };
  }, []);

  return (
    <div ref={trackRef} className="th-track">
      <div className="th-stage" style={{ ["--scrim" as string]: String(1 - Math.min(1, Math.max(0, (scrollP - 0.35) / 0.3)) * 0.85) }}>
        <div ref={hostRef} className="pair-host" aria-hidden="true" />
        <canvas ref={canvasRef} className="th-canvas" role="img"
          aria-label="Mary talks to her webcam and, pixel by pixel, becomes Tom, a different person, made from one photo" />
        {children(scrollP)}
      </div>
    </div>
  );
}
