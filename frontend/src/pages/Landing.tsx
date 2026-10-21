import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { DEMO_LOOKS, StudioDemo } from "../components/StudioDemo";
import "../styles/landing.css";

// The landing page is one board of tiles, like the pixels of a webcam frame. The hero frame re-renders itself from
// one look to the next block by block, the way VYRANI redraws a camera frame.
// Pictures are AI-generated illustrations of a fictional person (not recordings of the product); real VYRANI
// recordings dropped into person_studio/web/site/samples/ replace the illustration where a slot exists.
const LOOKS_DIR = "/assets/site/looks/";
const SAMPLES = "/assets/site/samples/";

type Look = { id: string; name: string; source: "Photo" | "Words"; prompt: string; detail: string };
const LOOKS: Look[] = [
  { id: "astronaut", name: "Astronaut", source: "Words", prompt: "Astronaut on a space station", detail: "The room behind her changes too: the bookshelf becomes a cabin window with the Earth in it." },
  { id: "professor", name: "Seventy years on", source: "Words", prompt: "Same person, age 70", detail: "She stays herself: silver hair, glasses, tweed. Useful for film, theatre and storytelling." },
  { id: "anchor", name: "News anchor", source: "Photo", prompt: "Reference photo: studio portrait", detail: "One clear photo sets the look. The suit and studio come from the photo; the expression comes from her." },
  { id: "warrior", name: "Norse warrior", source: "Words", prompt: "Norse warrior by firelight", detail: "Braids, fur and firelight. Costume looks for streams and live shows, without a costume." },
  { id: "jazz", name: "Jazz singer", source: "Words", prompt: "1920s jazz singer, pearls", detail: "Finger waves, pearls and stage light, typed in one line. Lips and eyes still follow her speech." },
  { id: "neon", name: "Night courier", source: "Words", prompt: "Cyberpunk courier, neon rain", detail: "Neon from a rainy street lights her face from the side, the way the words asked." },
  { id: "painting", name: "Oil portrait", source: "Words", prompt: "Renaissance oil painting", detail: "Not only people: styles too. Brush strokes and cracked varnish, still moving when she does." },
];
const src = (id: string) => `${LOOKS_DIR}${id}.jpg`;

const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Reveals the parts of each section once as it scrolls in. Content is visible without script.
function useReveal() {
  useEffect(() => {
    if (reduceMotion() || !("IntersectionObserver" in window)) return;
    const items = Array.from(document.querySelectorAll<HTMLElement>(".landing [data-reveal]"));
    items.forEach((el) => el.classList.add("is-waiting"));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.remove("is-waiting");
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

// The real person and the changed video, playing in step inside a drawing of the studio, with a draggable divider.
function Split() {
  const [pick, setPick] = useState(0);
  return (
    <section className="split" aria-labelledby="split-title">
      <div className="split-head" data-reveal>
        <h2 id="split-title">A new face, the same second</h2>
        <p>One reference photo becomes a whole different person who talks, smiles and gestures exactly as you do. Drag the line to compare.</p>
        <div className="split-picks" role="group" aria-label="Choose a demo">
          {DEMO_LOOKS.map((s, i) => (
            <button key={s.id} className={`split-pick${i === pick ? " is-on" : ""}`} aria-pressed={i === pick} onClick={() => setPick(i)}>{s.from} → {s.name}</button>
          ))}
        </div>
      </div>
      <div data-reveal><StudioDemo variant="split" look={pick} /></div>
      <p className="split-note">Everyone shown is AI-generated and fictional. Each change was made from one reference photo by VYRANI's video models, not edited by hand. Use real faces only with consent.</p>
    </section>
  );
}

function useClip(file: string) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    fetch(SAMPLES + file, { method: "HEAD" }).then((r) => setOk(r.ok && (r.headers.get("content-type") || "").startsWith("video/"))).catch(() => {});
  }, [file]);
  return ok;
}

const STAGES = [
  { name: "Camera", text: "Open the studio in Chrome, Edge or Safari and allow your webcam. Nothing to install. A quick check tells you if your light and connection are good enough." },
  { name: "Look", text: "Type who you want to be, or drop in one clear photo. VYRANI writes the detailed description for you, so a few words are enough." },
  { name: "Go live", text: "Press Go live. Talk, turn and laugh: your face, mouth and hands drive the new look in real time, at about the speed of a video call." },
  { name: "Anywhere", text: "Record the result, stream it out, or bring it into Google Meet and WhatsApp Web with the VYRANI browser extension. Switch looks without hanging up." },
];

const FAQ: [string, string][] = [
  ["Do I need to install anything?", "No. VYRANI runs in a computer browser with your own webcam. To use it inside video calls, add the free VYRANI extension."],
  ["How real does it look?", "Very convincing in good, even light with your face clearly in view. Fast movement, hands across the face and dark rooms are still where it slips. The studio checks your light before you start."],
  ["Can I become a real person?", "Only yourself, or someone who has agreed to it in writing. Passing yourself off as someone else closes the account."],
  ["Is the video marked as AI?", "Yes. Every recording carries a tag that says it was made with AI, and live video can show a visible VYRANI label."],
  ["Does it work on my phone?", "You can browse and manage your account on a phone. Going live is built for a laptop or desktop with a webcam."],
  ["What does it cost?", "Your first account gets a free 30-second live trial after confirming its email. Plans and prices are shown once you sign in."],
];

const FEATURES = [
  { title: "Talk and move", line: "Your mouth, eyes and turns drive the look as you speak.", size: "t-6x4", kind: "image", id: "swap-b", clip: "swap-b.mp4" },
  { title: "Go live in one press", line: "One button. The studio handles the rest.", size: "t-3x2", kind: "golive" },
  { title: "Record", line: "Download the file the moment you stop.", size: "t-3x2", kind: "rec" },
  { title: "Present as anyone", line: "Read the news, pitch, teach.", size: "t-3x4", kind: "image", id: "anchor", clip: "clip-anchor.mp4" },
  { title: "Change looks mid-call", line: "Type a new look; no restart.", size: "t-3x2", kind: "image", id: "neon" },
  { title: "Age, era, style", line: "Yourself at seventy, or in 1520.", size: "t-3x2", kind: "image", id: "professor" },
  { title: "Marked as AI", line: "A tag in every file, a label on screen.", size: "t-3x4", kind: "label" },
  { title: "Match your voice", line: "Sound like who you've become.", size: "t-6x2", kind: "voice" },
  { title: "Not only people", line: "Styles, eras, paintings.", size: "t-6x2", kind: "image", id: "painting" },
  { title: "Costume, no costume", line: "Firelight, fur and braids, live on stream.", size: "t-6x2", kind: "image", id: "warrior" },
] as { title: string; line: string; size: string; kind: string; id?: string; clip?: string }[];

const ALT: Record<string, string> = {
  jazz: "the same woman as a 1920s jazz singer", "swap-b": "a man on a work call, replaced by a different woman from one photo", anchor: "the same woman as a news anchor", astronaut: "the same woman as an astronaut",
  professor: "the same woman at seventy", neon: "the same woman as a neon-lit night courier", warrior: "the same woman as a Norse warrior", painting: "the same woman as an oil portrait",
};

// A muted loop with its still as the poster; the still alone if the clip can't play or motion is reduced.
function TileMedia({ id, clip }: { id: string; clip?: string }) {
  const alt = `Illustration: ${ALT[id] || "a look"}`;
  if (!clip || reduceMotion()) return <img src={src(id)} alt={alt} width={1376} height={768} loading="lazy" />;
  return <video src={LOOKS_DIR + clip} poster={src(id)} autoPlay muted loop playsInline preload="none" aria-label={`${alt} (AI-generated clip)`} />;
}

// A recording timer that really counts, as it does in the studio.
function RecTimer() {
  const [s, setS] = useState(42);
  useEffect(() => {
    if (reduceMotion()) return;
    const t = setInterval(() => setS((n) => (n >= 599 ? 0 : n + 1)), 1000);
    return () => clearInterval(t);
  }, []);
  const mm = String(Math.floor(s / 60)).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
  return (
    <div className="fx fx-rec" data-ui aria-hidden="true">
      <span className="fx-rec-row"><span className="fx-rec-dot" />REC<span className="fx-rec-time">{mm}:{ss}</span></span>
      <span className="fx-rec-bar"><span style={{ width: `${(s % 60) / 0.6}%` }} /></span>
    </div>
  );
}

function FeatureUi({ kind }: { kind: string }) {
  if (kind === "golive") return <div className="fx fx-golive" data-ui aria-hidden="true"><span className="fx-golive-btn"><span className="fx-dot" />Go live</span></div>;
  if (kind === "rec") return <RecTimer />;
  if (kind === "label") return <div className="fx fx-label" data-ui aria-hidden="true">VYRANI · AI</div>;
  if (kind === "voice") return (
    <div className="fx fx-voice" data-ui aria-hidden="true">
      {Array.from({ length: 18 }, (_, i) => <span key={i} style={{ animationDelay: `${(i % 6) * -0.17}s` }} />)}
    </div>
  );
  return null;
}

export function Landing() {
  const { me } = useAuth();
  const [heroLook, setHeroLook] = useState(0);
  const heroLoops = useRef(0);
  const heroClip = useClip("hero.mp4");
  const [stage, setStage] = useState(0);
  const [question, setQuestion] = useState(0);
  const [openRow, setOpenRow] = useState(0);
  useReveal();

  const primary = me ? { to: "/app/studio", label: "Open the studio" } : { to: "/signup", label: "Try it free" };

  return (
    <div className="landing">
      {/* Hero: the name band, link tiles, and three columns of tiles. */}
      <header className="board hero" aria-label="VYRANI">
        <div className="tile name-band"><p className="name-text" aria-hidden="true">VYRANI VYRANI</p><span className="sr-only">VYRANI</span></div>
        <nav className="links" aria-label="Sections">
          <a className="tile link-tile" href="#looks">Looks</a>
          <a className="tile link-tile" href="#how">How it works</a>
          <a className="tile link-tile" href="#faq">Questions</a>
          {me ? <Link className="tile link-tile" to="/app">My account</Link> : <Link className="tile link-tile" to="/signin">Sign in</Link>}
        </nav>
        <div className="rail-left">
          <figure className="tile photo-tile">
            <img src={src("cam")} alt="Illustration: a woman on her webcam at home, before any look" width={1376} height={768} />
          </figure>
          <ul className="tile facts">
            <li>Runs in your browser</li>
            <li>One photo or a few words</li>
            <li>Change looks mid-call</li>
            <li>Google Meet and WhatsApp Web</li>
            <li>Always marked as AI</li>
          </ul>
        </div>
        <div className="hero-stage">
          {heroClip
            ? <video className="pframe-video" src={`${SAMPLES}hero.mp4`} autoPlay muted loop playsInline aria-label="A VYRANI live session" />
            : <StudioDemo variant="pip" look={heroLook} className="hero-demo"
                onLoop={() => { heroLoops.current++; if (heroLoops.current % 3 === 0) setHeroLook((n) => n + 1); }} />}
          <div className="tile statement">
            <h1>Turn your webcam into anyone, live.</h1>
          </div>
        </div>
        <div className="rail-right">
          <p className="tile rr rr-1">Starts in seconds</p>
          <p className="tile rr rr-2">Talk, turn, laugh</p>
          <p className="tile rr rr-3">Record or stream</p>
          <p className="tile rr rr-4">A free live trial</p>
          <Link className="tile rr rr-action" to={primary.to}>{primary.label}<span aria-hidden="true">→</span></Link>
        </div>
      </header>

      <main>
        {/* Looks, set like a departure board. */}
        <section id="looks" className="looks" aria-labelledby="looks-title">
          <h2 id="looks-title" className="sr-only">Looks</h2>
          <div className="departures" data-ui>
            {LOOKS.map((look, i) => {
              const open = openRow === i;
              return (
                <button key={look.id} className={`dep${open ? " is-open" : ""}`} aria-expanded={open}
                  onClick={() => setOpenRow(i)}
                  onMouseEnter={() => setOpenRow(i)} onFocus={() => setOpenRow(i)}>
                  <img className="dep-thumb" src={src(look.id)} alt="" width={1376} height={768} loading="lazy" />
                  <span className="dep-name">{look.name}</span>
                  <span className="dep-src">{look.source}</span>
                  <span className="dep-prompt">“{look.prompt}”</span>
                  <span className="dep-status">Live</span>
                  {open && <span className="dep-detail">{look.detail}</span>}
                </button>
              );
            })}
          </div>
        </section>

        <Split />

        <div className="marquee" aria-hidden="true">
          <div className="marquee-track">
            {Array.from({ length: 4 }, (_, i) => <span key={i}>Be anyone, live <i className="px" /> Who will you be today <i className="px" /></span>)}
          </div>
        </div>

        {/* How it works: a horizontal accordion, dark to light. */}
        <section id="how" className="how" aria-labelledby="how-title">
          <div className="how-intro" data-reveal>
            <h2 id="how-title">Four steps, one minute</h2>
            <p>No green screen, no headset, no download. If you can join a video call, you can be someone else in it.</p>
          </div>
          <div className="accordion" data-reveal>
            {STAGES.map((s, i) => (
              <button key={s.name} className={`panel p${i}${stage === i ? " is-open" : ""}`} aria-expanded={stage === i} onClick={() => setStage(i)}>
                <span className="panel-name">{s.name}</span>
                <span className="panel-text">{s.text}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Features: close-ups of the studio on a board. */}
        <section className="features" aria-labelledby="features-title">
          <div className="fboard">
            <div className="tile ftile t-6x2 f-head" data-reveal>
              <h2 id="features-title">Made for calls and streams</h2>
              <p>Everything you need to go live as someone else, in one browser tab.</p>
            </div>
            {FEATURES.map((f) => (
              <div key={f.title} className={`tile ftile ${f.size} f-${f.kind}`} data-reveal>
                {f.kind === "image" && f.id ? <TileMedia id={f.id} clip={f.clip} /> : <FeatureUi kind={f.kind} />}
                <div className="fcap"><h3>{f.title}</h3><p>{f.line}</p></div>
              </div>
            ))}
          </div>
        </section>

        {/* Questions on the left, one answer large on the right. */}
        <section id="faq" className="faq" aria-labelledby="faq-title">
          <div className="faq-list" data-reveal>
            <h2 id="faq-title">Questions</h2>
            {FAQ.map(([q, a], i) => (
              <div key={q} className={`faq-item${question === i ? " is-on" : ""}`}>
                <button aria-expanded={question === i} onClick={() => setQuestion(i)} onMouseEnter={() => setQuestion(i)} onFocus={() => setQuestion(i)}>
                  <span className="faq-dot" aria-hidden="true" />{q}
                </button>
                <p className="faq-inline">{a}</p>
              </div>
            ))}
          </div>
          <p key={question} className="faq-pane" aria-live="polite">{FAQ[question][1]}</p>
        </section>

        {/* The close: one row of the board. */}
        <section className="cta" aria-labelledby="cta-title">
          <img className="tile cta-side" src={src("neon")} alt="" width={1376} height={768} loading="lazy" />
          <div className="tile cta-main" data-reveal>
            <h2 id="cta-title">Who will you be today?</h2>
            <p>Make an account, confirm your email and your first 30 seconds live are on us. Use it with your own face, or with someone's consent.</p>
            <Link className="btn-board" to={primary.to}>{primary.label}</Link>
          </div>
          <div className="tile cta-side cta-flat" aria-hidden="true" />
        </section>
      </main>

      <footer className="foot">
        <div className="blocks" aria-hidden="true">
          {"VYRANI".split("").map((l, i) => <span key={i} className={`blk b${i}`}>{l}</span>)}
        </div>
        <div className="foot-cols">
          <nav aria-label="Footer">
            <a href="#looks">Looks</a><a href="#how">How it works</a><a href="#faq">Questions</a>
            {me ? <Link to="/app/credits">Plans and credits</Link> : <Link to="/signin">Sign in</Link>}
          </nav>
          <p>Use VYRANI only with your own face or with the consent of anyone shown. Pictures on this page are AI-generated illustrations of a fictional person.</p>
        </div>
        <div className="foot-last">
          <p>© 2026 VYRANI</p>
          <Link className="btn-board btn-small" to={primary.to}>{primary.label}</Link>
        </div>
      </footer>
    </div>
  );
}
