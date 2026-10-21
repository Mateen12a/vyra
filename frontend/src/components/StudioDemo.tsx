import { useEffect, useRef, useState } from "react";
import "../styles/studio-demo.css";

// A drawing of the VYRANI studio playing a real before/after pair: a camera clip and the same clip with the person
// replaced from one reference photo, kept on the same frame. Everyone shown is AI-generated and fictional. "pip" shows the result on stage with the camera in a corner, as the
// studio does while live; "split" puts a draggable divider between the two.
const DIR = "/assets/site/looks/";
export const DEMO_LOOKS = [
  { id: "swap-a", cam: "swap-a-cam", ref: "ref-man.jpg", from: "Mary", name: "Tom", prompt: "Become Tom, from one photo" },
  { id: "swap-b", cam: "swap-b-cam", ref: "ref-woman.jpg", from: "Mark", name: "Gwen", prompt: "Become Gwen, from one photo" },
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
  const cam = useRef<HTMLVideoElement>(null), out = useRef<HTMLVideoElement>(null), box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(50);
  const [secs, setSecs] = useState(0);
  const typed = useTyped(item.prompt);
  const loopRef = useRef(onLoop);
  loopRef.current = onLoop;

  useEffect(() => {
    const a = cam.current, b = out.current;
    if (!a || !b) return;
    if (reduce()) { a.pause(); b.pause(); return; }
    // The changed clip leads; the camera clip follows it so both show the same moment.
    const sync = () => { if (Math.abs(a.currentTime - b.currentTime) > 0.08) a.currentTime = b.currentTime; };
    const restart = () => { a.currentTime = 0; b.currentTime = 0; a.play().catch(() => {}); b.play().catch(() => {}); };
    const ended = () => { restart(); loopRef.current?.(); };
    b.addEventListener("timeupdate", sync); b.addEventListener("ended", ended);
    restart();
    return () => { b.removeEventListener("timeupdate", sync); b.removeEventListener("ended", ended); };
  }, [look]);

  useEffect(() => {
    if (reduce()) return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  function drag(x: number) {
    const r = box.current!.getBoundingClientRect();
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

      <div ref={box} className="sdemo-stage"
        {...(variant === "split" ? {
          onPointerDown: (e: React.PointerEvent) => drag(e.clientX),
          onPointerMove: (e: React.PointerEvent) => { if (e.buttons) drag(e.clientX); },
        } : {})}>
        <video ref={out} key={`o-${item.id}`} className="sdemo-video" src={`${DIR}${item.id}.mp4`} poster={`${DIR}${item.id}.jpg`}
          muted playsInline preload="auto" aria-label={`Live result: ${item.from} as ${item.name}`} />
        {variant === "split" ? (
          <>
            <div className="sdemo-left" style={{ clipPath: `inset(0 ${100 - at}% 0 0)` }}>
              <video ref={cam} key={`c-${item.id}`} className="sdemo-video" src={`${DIR}${item.cam}.mp4`} poster={`${DIR}${item.cam}.jpg`} muted playsInline preload="auto" aria-label="Your camera" />
            </div>
            <span className="sdemo-line" style={{ left: `${at}%` }} aria-hidden="true"><span className="sdemo-knob" /></span>
            <span className="sdemo-tag sdemo-tag-l">{item.from} on camera</span>
            <span className="sdemo-tag sdemo-tag-r">{item.from} as {item.name}, live</span>
            <input className="sdemo-range" type="range" min={0} max={100} value={Math.round(at)} onChange={(e) => setAt(Number(e.target.value))}
              aria-label="Move the divider between your camera and the live result" />
          </>
        ) : (
          <>
            <div className="sdemo-pip">
              <video ref={cam} key={`c-${item.id}`} className="sdemo-video" src={`${DIR}${item.cam}.mp4`} poster={`${DIR}${item.cam}.jpg`} muted playsInline preload="auto" aria-label="Your camera" />
              <span className="sdemo-pip-tag">You</span>
            </div>
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
