import { useCallback, useEffect, useRef, useState } from "react";
import { BroadcastIcon, CameraIcon, Dialog, ImageIcon, Spinner } from "../components/ui";
import { api } from "../lib/api";
import "./setup-tour.css";

type SetupStep = { id: string; title: string; status: "done" | "missing" | "optional" | "guide"; detail?: string; fix?: string | null };
type SetupState = { mode: "local" | "hosted"; steps: SetupStep[] };
const CHAPTERS = [
  { label: "Camera", title: "Start with you.", text: "Turn on your camera and allow access when your browser asks. Choose your physical webcam as the input.", action: "Next: choose a look" },
  { label: "Your look", title: "Make it your own.", text: "Describe a look, or upload a character photo you have permission to use. Choose Use this look to apply it.", action: "Next: go live" },
  { label: "Go live", title: "Now bring it to life.", text: "Press Go live and wait for the transformed preview. You can change looks while you move, speak or record.", action: "Next: use it in a call" },
  { label: "Calls", title: "Choose where to show up.", text: "For supported calling websites, install the extension and select VYRA AI Virtual Camera. Keep Studio live in another tab.", action: "Open studio" },
];

// These illustrations never open a camera, connect to an AI service, or spend credits.
function MotionScene({ chapter, paused }: { chapter: number; paused: boolean }) {
  return (
    <div className={`tour-scene tour-scene-${chapter}${paused ? " tour-paused" : ""}`} aria-hidden="true" key={chapter}>
      <div className="tour-scene-top"><span className="tour-window-dots"><i /><i /><i /></span><span>YOUR STUDIO</span></div>
      <div className="tour-viewfinder">
        <span className="tour-corner tour-corner-a" /><span className="tour-corner tour-corner-b" />
        <div className="tour-person"><div className="tour-person-head" /><div className="tour-person-body" /></div>
        {chapter > 0 && <div className="tour-reveal"><div className="tour-person tour-person-styled"><div className="tour-person-head" /><div className="tour-person-body" /></div></div>}
        {chapter === 0 && <div className="tour-permission"><CameraIcon /><span>Allow camera</span><span className="tour-permission-yes">Allow</span></div>}
        {chapter === 1 && <div className="tour-prompt"><ImageIcon /><span>A tailored black tuxedo</span></div>}
        {chapter === 2 && <div className="tour-live"><span />LIVE PREVIEW</div>}
        {chapter === 3 && <div className="tour-device"><CameraIcon /><span>VYRA AI Virtual Camera</span><span className="tour-device-check">✓</span></div>}
      </div>
      <div className="tour-scene-bottom"><span>{["Camera permission", "A new look. Same movement.", "Preview → record or call", "Studio → extension → calling tab"][chapter]}</span><BroadcastIcon /></div>
    </div>
  );
}

export function SetupTour({ extensionReady, onClose }: { extensionReady: boolean; onClose: () => void }) {
  const [chapter, setChapter] = useState(0);
  const [paused, setPaused] = useState(false);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState<"browser" | "desktop">("browser");
  const runRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const refresh = useCallback(async () => {
    const run = ++runRef.current;
    setLoading(true);
    setError("");
    try {
      const body = await api<SetupState>("/api/setup");
      if (!body || !Array.isArray(body.steps) || !body.steps.some(step => step.id === "engine")) throw new Error("Setup status is incomplete. Please try again.");
      if (runRef.current === run) setSetup(body);
    } catch (err) {
      if (runRef.current === run) {
        setSetup(null);
        setError(err instanceof Error ? err.message : "Couldn't check your setup.");
      }
    } finally {
      if (runRef.current === run) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); return () => { ++runRef.current; }; }, [refresh]);
  useEffect(() => {
    const dialog = contentRef.current?.closest<HTMLElement>('[role="dialog"]');
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]')).filter(el => el.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement?.getAttribute("tabindex") === "-1")) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog?.addEventListener("keydown", trap);
    return () => { dialog?.removeEventListener("keydown", trap); document.body.style.overflow = oldOverflow; };
  }, []);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [chapter]);

  async function installFFmpeg() {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await api("/api/setup/fix/ffmpeg", {}); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "Installation failed. Please try again."); }
    finally { setBusy(false); }
  }

  const engine = setup?.steps.find(step => step.id === "engine");
  const ready = !loading && !error && engine?.status === "done";
  const page = CHAPTERS[chapter];
  const displaySteps = setup?.steps.filter(step => step.id === "engine" || step.id === "ffmpeg" || step.id === (destination === "browser" ? "extension" : "camera_apps")) ?? [];

  return (
    <Dialog title="Your first look, in four steps" onClose={onClose} wide>
      <div className="studio-tour" ref={contentRef} data-testid="studio-tour">
        <nav className="tour-chapters" aria-label="Studio tour steps">
          {CHAPTERS.map((item, index) => <button type="button" key={item.label} aria-current={index === chapter ? "step" : undefined} onClick={() => setChapter(index)}>
            <span>{String(index + 1).padStart(2, "0")}</span>{item.label}
          </button>)}
        </nav>
        <div className="tour-art">
          <MotionScene chapter={chapter} paused={paused} />
          <div className="tour-art-caption"><span>Animated walkthrough</span><button type="button" className="tour-motion-toggle" aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? "Play motion" : "Pause motion"}</button></div>
        </div>
        <div className="tour-copy" key={chapter}>
          <p className="tour-eyebrow">STEP {chapter + 1} OF 4</p>
          <h3 ref={headingRef} tabIndex={-1}>{page.title}</h3>
          <p className="muted">{page.text}</p>
          {chapter === 0 && <p className="tour-note">This tour is an illustration. Your camera stays off until you turn it on in Studio.</p>}
          {chapter === 1 && <p className="tour-note">Using a real likeness? Confirm consent. VYRA adds an AI disclosure.</p>}
          {chapter === 2 && <p className="tour-note">Live transformations use credits. Watching this tour uses none.</p>}
        </div>
        {chapter === 3 && <section className="tour-readiness" aria-label="Your setup">
          <div className="tour-destinations" role="group" aria-label="Where you will use VYRA">
            <button type="button" aria-pressed={destination === "browser"} onClick={() => setDestination("browser")}>Browser calls</button>
            <button type="button" aria-pressed={destination === "desktop"} onClick={() => setDestination("desktop")}>Desktop apps</button>
          </div>
          {destination === "desktop" && <p className="tour-note">Desktop apps need OBS Studio and its Virtual Camera. Capture VYRA's clean output window in OBS, then select OBS Virtual Camera in your calling app. Compatibility needs testing in that app. A hosted VYRA website cannot launch OBS on your computer.</p>}
          {loading && <p className="setup-loading" role="status"><Spinner /> Checking your setup…</p>}
          {error && <div className="tour-error" role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={loading || busy} onClick={() => void refresh()}>Try again</button></div>}
          {!loading && setup && displaySteps.map(step => {
            const detected = step.id === "extension" ? extensionReady : step.status === "done";
            return <div className="tour-check" key={step.id}>
              <div><strong>{step.title}</strong><span className={detected ? "tour-ready" : "muted"}>{detected ? (step.id === "extension" ? "Detected in this browser" : "Configured") : step.detail}</span></div>
              {step.id === "extension" && !extensionReady && <a className="btn btn-ghost" href="/api/virtual-cam/extension.zip" download="vyra-virtual-camera-extension.zip">Download extension</a>}
              {step.id === "camera_apps" && !detected && <a className="btn btn-ghost" href="https://obsproject.com/download" target="_blank" rel="noreferrer">Get OBS</a>}
              {step.fix === "download-ffmpeg" && !detected && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void installFFmpeg()}>{busy ? "Installing…" : "Install FFmpeg"}</button>}
            </div>;
          })}
          {destination === "browser" && !extensionReady && <p className="tour-note">Until the store release: extract the download, open chrome://extensions, enable Developer mode, and choose Load unpacked. Select the extracted folder, then refresh Studio and your calling tab.</p>}
          <button type="button" className="tour-refresh" disabled={loading || busy} onClick={() => void refresh()}>Check setup again</button>
        </section>}
        <footer className="tour-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Skip for now</button>
          <div>{chapter > 0 && <button type="button" className="btn btn-ghost" onClick={() => setChapter(value => value - 1)}>Back</button>}
            <button type="button" className="btn btn-primary" disabled={chapter === 3 && (!ready || busy)} onClick={() => chapter === 3 ? onClose() : setChapter(value => value + 1)}>{page.action}</button>
          </div>
        </footer>
      </div>
    </Dialog>
  );
}
