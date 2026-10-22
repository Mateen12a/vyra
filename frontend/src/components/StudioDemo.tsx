import { useEffect, useRef, useState } from "react";
import { drawHalf, PairPlayer } from "./pair";
import "../styles/studio-demo.css";

// A drawing of the VYRANI studio playing a real before/after pair (camera and result in one video, so they can never
// drift). "pip" shows the result on stage with the camera in a corner, as the studio does while live; "split" puts a
// draggable divider between them. Everyone shown is AI-generated and fictional.
const DIR = "/assets/site/looks/";
export const DEMO_LOOKS = [
  { id: "pair-a", ref: "ref-man.jpg", from: "Mary", name: "Tom", prompt: "Become Tom, from one photo" },
  { id: "pair-b", ref: "ref-woman.jpg", from: "Mark", name: "Gwen", prompt: "Become Gwen, from one photo" },
];

const reduce = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function useTyped(text: string) {
  const [shown, setShown] = useState(reduce() ? text : "");
  useEffect(() => {
    if (reduce()) { setShown(text); return; }
    setShown("");
    let i = 0;
    const t = setInterval(() => { i++; setShown(text.slice(0, i)); if (i >= text.length) clearInterval(t); }, 32);
    return () => clearInterval(t);
  }, [text]);
  return shown;
}

export function StudioDemo({ variant, look, onLoop, className = "" }: { variant: "pip" | "split"; look: number; onLoop?: () => void; className?: string }) {
  const item = DEMO_LOOKS[look % DEMO_LOOKS.length];
  const stageRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), hostRef = useRef<HTMLDivElement>(null);
  const atRef = useRef(50);
  const [at, setAt] = useState(50);
  const [secs, setSecs] = useState(0);
  const typed = useTyped(item.prompt);
  const loopRef = useRef(onLoop);
  loopRef.current = onLoop;
  atRef.current = at;

  useEffect(() => {
    const canvas = canvasRef.current!, host = hostRef.current!;
    const ctx = canvas.getContext("2d")!;
    const player = new PairPlayer(host, item.id, !reduce());
    player.onLoop = () => loopRef.current?.();
    let raf = 0, alive = true;
    const size = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(canvas);
    // Only draw and play while on screen: saves battery and keeps phones smooth.
    let visible = true;
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !reduce()) player.resume(); else player.video.pause();
    });
    io.observe(canvas);
    const draw = () => {
      if (!alive) return;
      raf = requestAnimationFrame(draw);
      if (!visible) return;
      const f = player.frame();
      if (!f) return;
      const W = canvas.width, H = canvas.height;
      drawHalf(ctx, f, 1, 0, 0, W, H);
      if (variant === "split") {
        const x = Math.round((atRef.current / 100) * W);
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, x, H); ctx.clip();
        drawHalf(ctx, f, 0, 0, 0, W, H);
        ctx.restore();
      } else {
        const pad = Math.round(W * 0.018), pw = Math.round(W * 0.26), ph = Math.round(pw * 9 / 16);
        drawHalf(ctx, f, 0, W - pw - pad, pad, pw, ph);
      }
    };
    raf = requestAnimationFrame(draw);
    const wake = () => { if (!reduce()) player.resume(); };
    addEventListener("touchstart", wake, { once: true, passive: true });
    addEventListener("click", wake, { once: true });
    return () => {
      alive = false; cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); player.destroy();
      removeEventListener("touchstart", wake); removeEventListener("click", wake);
    };
  }, [item.id, variant]);

  useEffect(() => {
    if (reduce()) return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  function drag(x: number) {
    const r = stageRef.current!.getBoundingClientRect();
    setAt(Math.min(100, Math.max(0, ((x - r.left) / r.width) * 100)));
  }
  const clock = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;

  return (
    <div className={`sdemo sdemo--${variant} ${className}`} data-ui>
      <div className="sdemo-bar">
        <span className="sdemo-brand"><img className="sdemo-mark" src="/assets/brand/vyrani-mark.svg" alt="" />VYRANI Studio</span>
        <span className="sdemo-live"><span className="sdemo-dot" aria-hidden="true" />Live {clock}</span>
        <span className="sdemo-credits">{Math.max(0, 540 - secs)} credits</span>
      </div>

      <div ref={stageRef} className="sdemo-stage"
        {...(variant === "split" ? {
          onPointerDown: (e: React.PointerEvent) => drag(e.clientX),
          onPointerMove: (e: React.PointerEvent) => { if (e.buttons) drag(e.clientX); },
        } : {})}>
        <div ref={hostRef} className="pair-host" aria-hidden="true" />
        <canvas ref={canvasRef} className="sdemo-canvas" role="img"
          aria-label={`${item.from} on camera and ${item.from} as ${item.name}, a different person made from one photo`} />
        {variant === "split" ? (
          <>
            <span className="sdemo-line" style={{ left: `${at}%` }} aria-hidden="true"><span className="sdemo-knob" /></span>
            <span className="sdemo-tag sdemo-tag-l">{item.from} on camera</span>
            <span className="sdemo-tag sdemo-tag-r">{item.from} as {item.name}, live</span>
            <input className="sdemo-range" type="range" min={0} max={100} value={Math.round(at)} onChange={(e) => setAt(Number(e.target.value))}
              aria-label="Move the divider between the camera and the live result" />
          </>
        ) : (
          <>
            <div className="sdemo-pip" aria-hidden="true"><span className="sdemo-pip-tag">You</span></div>
            <span className="sdemo-tag sdemo-tag-l">{item.from} as {item.name}</span>
          </>
        )}
      </div>

      <div className="sdemo-composer">
        <img className="sdemo-thumb" src={`${DIR}${item.ref}`} alt={`Reference photo of ${item.name}`} />
        <span className="sdemo-input"><span className="sdemo-typed">{typed}</span><span className="sdemo-caret" aria-hidden="true" /></span>
        <span className="sdemo-go"><span className="sdemo-dot" aria-hidden="true" />Live</span>
      </div>
    </div>
  );
}
