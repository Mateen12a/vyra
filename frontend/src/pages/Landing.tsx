import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ImageIcon, StudioIcon, Wordmark } from "../components/ui";
import { useAuth } from "../lib/auth";
import "../styles/landing.css";

// Real recordings made in VYRANI go in person_studio/web/site/samples/. Each slot shows only when its file exists.
const SAMPLES = "/assets/site/samples/";
async function exists(file: string) {
  try { return (await fetch(SAMPLES + file, { method: "HEAD" })).ok; } catch { return false; }
}
function useSamples() {
  const [found, setFound] = useState<Record<string, boolean>>({});
  useEffect(() => {
    Promise.all(["hero.mp4", "before.mp4", "after.mp4"].map(async (f) => [f, await exists(f)] as const))
      .then((pairs) => setFound(Object.fromEntries(pairs)));
  }, []);
  return found;
}

// The studio window, as it really looks. Plays a recorded clip when there is one; otherwise visitors can
// see their own camera inside it (opt-in, local only, nothing is uploaded or transformed here).
function PreviewFrame({ hasClip }: { hasClip: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cam, setCam] = useState<"off" | "on" | "blocked">("off");
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);
  async function tryCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
      setCam("on");
    } catch { setCam("blocked"); }
  }
  return (
    <div className="frame" data-ui>
      <div className="frame-bar"><span /><span /><span /><p>VYRANI studio</p></div>
      <div className="frame-stage">
        {hasClip ? (
          <video className="frame-video" src={`${SAMPLES}hero.mp4`} autoPlay muted loop playsInline aria-label="VYRANI transforming a person live" />
        ) : (
          <>
            <video ref={videoRef} className={`frame-video mirrored${cam === "on" ? "" : " is-hidden"}`} playsInline muted aria-label="Your camera preview" />
            {cam !== "on" && (
              <div className="frame-empty">
                <p className="frame-empty-title">See yourself in the studio</p>
                <p className="muted">Your camera stays on this device. Transformations start once you sign in.</p>
                <button className="btn btn-light" onClick={tryCamera}>Turn on my camera</button>
                {cam === "blocked" && <p className="field-error">Camera access was blocked. You can still sign up and try it in the studio.</p>}
              </div>
            )}
          </>
        )}
        {hasClip ? <div className="frame-live"><span className="live-dot" /> Live</div>
          : cam === "on" && <div className="frame-live">Your camera · not transformed yet</div>}
        {cam === "on" && !hasClip && <Link className="btn btn-primary frame-cta" to="/signup">Transform me</Link>}
      </div>
      <div className="frame-composer">
        <div className="frame-photo" aria-hidden="true"><ImageIcon /></div>
        <div className="frame-input"><span className="dim">Who do you want to be?</span> <span>A 1920s jazz singer</span></div>
        <span className="frame-go">Go live</span>
      </div>
    </div>
  );
}

function BeforeAfter() {
  const [split, setSplit] = useState(50);
  return (
    <div className="ba" data-ui>
      <video className="ba-video" src={`${SAMPLES}before.mp4`} autoPlay muted loop playsInline aria-label="Before: the camera" />
      <div className="ba-after" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
        <video className="ba-video" src={`${SAMPLES}after.mp4`} autoPlay muted loop playsInline aria-label="After: transformed live by VYRANI" />
      </div>
      <div className="ba-handle" style={{ left: `${split}%` }} aria-hidden="true" />
      <span className="ba-tag ba-tag-l">Camera</span><span className="ba-tag ba-tag-r">VYRANI, live</span>
      <input className="ba-range" type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-label="Compare before and after" />
    </div>
  );
}

const FAQ = [
  ["Do I need to install anything?", "No. VYRANI runs in Chrome, Edge or Safari on a computer. You need a webcam and a steady upload connection; the studio tests your connection before you go live."],
  ["How does the photo transformation work?", "Upload one clear photo of a character. VYRANI reads it, writes a description to strengthen the likeness, and maps that face and look onto you while you talk and move."],
  ["Can I become a real person?", "Only yourself, or someone who has agreed to it. Using VYRANI to pass yourself off as someone else gets the account closed."],
  ["What can I do with the video?", "Record it and download the file, or stream it out while you're live. You can also change your voice to match."],
  ["Is the video marked as AI?", "Yes. Every recording carries a hidden tag that says it was made with AI, and the studio can show a visible VYRANI · AI label."],
  ["Does it work on my phone?", "VYRANI is built for a computer browser today. Live works best on a laptop or desktop with a webcam."],
];

export function Landing() {
  const { me } = useAuth();
  const samples = useSamples();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(scrollY > 12);
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);
  const primary = me ? { to: "/app/studio", label: "Open studio" } : { to: "/signup", label: "Get started" };

  return (
    <div className="landing">
      <header className={`nav${scrolled ? " nav-solid" : ""}`}>
        <Wordmark />
        <nav className="nav-links" aria-label="Sections">
          <a href="#how">How it works</a><a href="#uses">What you can do</a><a href="#faq">Questions</a>
        </nav>
        <div className="nav-actions">
          {!me && <Link className="nav-signin" to="/signin">Sign in</Link>}
          <Link className="btn btn-primary btn-sm" to={primary.to}>{primary.label}</Link>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <h1 className="hero-title">Be anyone,<br />live.</h1>
          <p className="hero-sub">VYRANI turns your webcam into any character, from one photo or a few words, while you talk, move and record.</p>
          <div className="hero-actions">
            <Link className="btn btn-primary btn-lg" to={primary.to}>{primary.label}</Link>
            <a className="btn btn-ghost btn-lg" href="#how">See how it works</a>
          </div>
        </div>
        <PreviewFrame hasClip={Boolean(samples["hero.mp4"])} />
      </section>

      {samples["before.mp4"] && samples["after.mp4"] && (
        <section className="band">
          <h2 className="section-title">Same person. Same moment.</h2>
          <BeforeAfter />
        </section>
      )}

      <section id="how" className="how">
        <h2 className="section-title">Three steps, under a minute</h2>
        <div className="how-rows">
          <div className="how-row">
            <div className="how-text">
              <h3>Show it who to become</h3>
              <p className="muted">Drop in one photo of a character, or describe one in plain words. VYRANI writes the detailed instructions for you.</p>
            </div>
            <div className="ui-chip" data-ui><span className="ui-chip-icon"><ImageIcon /></span><div><strong>Character photo</strong><span className="muted">VYRANI will map this face onto you.</span></div></div>
          </div>
          <div className="how-row">
            <div className="how-text">
              <h3>Press Go live</h3>
              <p className="muted">Your camera changes in real time. Talk, turn, laugh: the character follows your face and movement.</p>
            </div>
            <div className="ui-golive" data-ui><span className="golive"><span className="golive-dot" />Go live</span></div>
          </div>
          <div className="how-row">
            <div className="how-text">
              <h3>Switch any time</h3>
              <p className="muted">Change the character or the look mid-session. It applies live, without restarting.</p>
            </div>
            <div className="ui-chip" data-ui><span className="ui-chip-icon"><StudioIcon /></span><div><strong>Now: astronaut</strong><span className="muted">Applied live</span></div></div>
          </div>
        </div>
      </section>

      <section id="uses" className="uses">
        <h2 className="section-title">Made for what comes next</h2>
        <div className="uses-list">
          <div><h3>Record</h3><p className="muted">Download your transformed video in one click, tagged as AI-made.</p></div>
          <div><h3>Stream</h3><p className="muted">Send the live result out to your streaming platform.</p></div>
          <div><h3>Change your voice</h3><p className="muted">Match how you sound to who you've become.</p></div>
          <div><h3>Nothing to install</h3><p className="muted">It all runs in your browser, with your own webcam.</p></div>
        </div>
      </section>

      <section id="faq" className="faq">
        <h2 className="section-title">Questions</h2>
        <div className="faq-list">
          {FAQ.map(([q, a], i) => (
            <details key={q} name="faq" open={i === 0}><summary>{q}</summary><p className="muted">{a}</p></details>
          ))}
        </div>
      </section>

      <section className="final">
        <h2 className="final-title">Who will you<br />be today?</h2>
        <Link className="btn btn-primary btn-lg" to={primary.to}>{primary.label}</Link>
      </section>

      <footer className="foot">
        <Wordmark />
        <p className="dim">Use VYRANI only with the consent of anyone shown.</p>
        <p className="dim">© 2026 VYRANI AI</p>
      </footer>
    </div>
  );
}
