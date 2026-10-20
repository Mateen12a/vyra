import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import "../styles/landing.css";

// The landing page is one board of tiles, like the pixels of a webcam frame. The hero frame re-renders itself from
// one look to the next block by block, the way VYRANI redraws a camera frame.
// Pictures are AI-generated illustrations of a fictional person (not recordings of the product); real VYRANI
// recordings dropped into person_studio/web/site/samples/ replace the illustration where a slot exists.
const LOOKS_DIR = "/assets/site/looks/";
const SAMPLES = "/assets/site/samples/";

type Look = { id: string; name: string; source: "Photo" | "Words"; prompt: string; detail: string };
const CAMERA = { id: "cam", name: "Your camera" };
const LOOKS: Look[] = [
  { id: "jazz", name: "Jazz singer", source: "Words", prompt: "1920s jazz singer, pearls", detail: "Finger waves, pearls and stage light, typed in one line. Lips and eyes still follow her speech." },
  { id: "astronaut", name: "Astronaut", source: "Words", prompt: "Astronaut on a space station", detail: "The room behind her changes too: the bookshelf becomes a cabin window with the Earth in it." },
  { id: "professor", name: "Seventy years on", source: "Words", prompt: "Same person, age 70", detail: "She stays herself: silver hair, glasses, tweed. Useful for film, theatre and storytelling." },
  { id: "anchor", name: "News anchor", source: "Photo", prompt: "Reference photo: studio portrait", detail: "One clear photo sets the look. The suit and studio come from the photo; the expression comes from her." },
  { id: "warrior", name: "Norse warrior", source: "Words", prompt: "Norse warrior by firelight", detail: "Braids, fur and firelight. Costume looks for streams and live shows, without a costume." },
  { id: "neon", name: "Night courier", source: "Words", prompt: "Cyberpunk courier, neon rain", detail: "Neon from a rainy street lights her face from the side, the way the words asked." },
  { id: "painting", name: "Oil portrait", source: "Words", prompt: "Renaissance oil painting", detail: "Not only people: styles too. Brush strokes and cracked varnish, still moving when she does." },
];
const src = (id: string) => `${LOOKS_DIR}${id}.jpg`;

const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// 8×8 ordered-dither matrix: the order in which blocks of the frame are redrawn.
const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// The frame: draws `from`, then redraws it block by block into `to`. Blocks on the moving front are shown coarse first.
function PixelFrame({ lookId, label }: { lookId: string; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shownRef = useRef<string>(CAMERA.id);
  const cache = useRef(new Map<string, { full: HTMLImageElement; coarse: HTMLCanvasElement }>());
  const [ready, setReady] = useState(false);

  async function get(id: string) {
    const hit = cache.current.get(id);
    if (hit) return hit;
    const full = await loadImage(src(id));
    const coarse = document.createElement("canvas");
    coarse.width = 48; coarse.height = 27;
    coarse.getContext("2d")!.drawImage(full, 0, 0, 48, 27);
    const entry = { full, coarse };
    cache.current.set(id, entry);
    return entry;
  }

  useEffect(() => {
    let cancelled = false, raf = 0;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height, COLS = 48, ROWS = 27, cw = W / COLS, ch = H / ROWS;
    (async () => {
      const [a, b] = await Promise.all([get(shownRef.current), get(lookId)]).catch(() => [null, null]);
      if (cancelled || !a || !b) return;
      setReady(true);
      if (shownRef.current === lookId || reduceMotion()) {
        ctx.drawImage(b.full, 0, 0, W, H);
        shownRef.current = lookId;
        return;
      }
      const start = performance.now(), DURATION = 1100;
      const tick = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - start) / DURATION);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(a.full, 0, 0, W, H);
        for (let y = 0; y < ROWS; y++) {
          for (let x = 0; x < COLS; x++) {
            // Sweep left to right, broken up by the dither order so the edge reads as pixels, not a wipe.
            const order = (x / COLS) * 0.6 + (BAYER[((y & 7) << 3) | (x & 7)] / 64) * 0.4;
            const done = t * 1.25 - order;
            if (done <= 0) continue;
            if (done < 0.18) {
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(b.coarse, x, y, 1, 1, x * cw, y * ch, cw + 0.5, ch + 0.5);
            } else {
              ctx.imageSmoothingEnabled = true;
              const sx = (x / COLS) * b.full.naturalWidth, sy = (y / ROWS) * b.full.naturalHeight;
              ctx.drawImage(b.full, sx, sy, b.full.naturalWidth / COLS, b.full.naturalHeight / ROWS, x * cw, y * ch, cw + 0.5, ch + 0.5);
            }
          }
        }
        if (t < 1) raf = requestAnimationFrame(tick);
        else { ctx.drawImage(b.full, 0, 0, W, H); shownRef.current = lookId; }
      };
      raf = requestAnimationFrame(tick);
    })();
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [lookId]);

  return (
    <div className="pframe">
      <img className="pframe-fallback" src={src(CAMERA.id)} alt="" width={1376} height={768} hidden={ready} />
      <canvas ref={canvasRef} className="pframe-canvas" width={1376} height={768} role="img" aria-label={`Illustration: the same person, now ${label}`} />
      <p className="pframe-tag"><span className="live-dot" aria-hidden="true" />{label}</p>
    </div>
  );
}

// Cycles the hero frame through the looks until the visitor picks one on the board.
function useLookCycle() {
  const [index, setIndex] = useState(-1); // -1 = the camera, before any look
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held || reduceMotion()) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % LOOKS.length), index < 0 ? 1600 : 3400);
    return () => clearInterval(timer);
  }, [held, index]);
  return { index, pick: (i: number) => { setHeld(true); setIndex(i); } };
}

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
  ["What does it cost?", "Every new account gets a free live minute after confirming its email. Plans and prices are shown once you sign in."],
];

const FEATURES = [
  { title: "Sing, talk, move", line: "Your mouth and face drive the look as you speak.", size: "t-6x4", kind: "image", id: "jazz", clip: "clip-jazz.mp4" },
  { title: "Go live in one press", line: "One button. The studio handles the rest.", size: "t-3x2", kind: "golive" },
  { title: "Record", line: "Download the file the moment you stop.", size: "t-3x2", kind: "rec" },
  { title: "Present as anyone", line: "Read the news, pitch, teach.", size: "t-3x4", kind: "image", id: "anchor", clip: "clip-anchor.mp4" },
  { title: "Change looks mid-call", line: "Type a new look; no restart.", size: "t-3x2", kind: "image", id: "astronaut" },
  { title: "Age, era, style", line: "Yourself at seventy, or in 1520.", size: "t-3x2", kind: "image", id: "professor" },
  { title: "Marked as AI", line: "A tag in every file, a label on screen.", size: "t-3x4", kind: "label" },
  { title: "Match your voice", line: "Sound like who you've become.", size: "t-6x2", kind: "voice" },
  { title: "Not only people", line: "Styles, eras, paintings.", size: "t-6x2", kind: "image", id: "painting" },
  { title: "Costume, no costume", line: "Firelight, fur and braids, live on stream.", size: "t-6x2", kind: "image", id: "warrior" },
] as { title: string; line: string; size: string; kind: string; id?: string; clip?: string }[];

const ALT: Record<string, string> = {
  jazz: "the same woman as a 1920s jazz singer", anchor: "the same woman as a news anchor", astronaut: "the same woman as an astronaut",
  professor: "the same woman at seventy", warrior: "the same woman as a Norse warrior", painting: "the same woman as an oil portrait",
};

// A muted loop with its still as the poster; the still alone if the clip can't play or motion is reduced.
function TileMedia({ id, clip }: { id: string; clip?: string }) {
  const alt = `Illustration: ${ALT[id] || "a look"}`;
  if (!clip || reduceMotion()) return <img src={src(id)} alt={alt} width={1376} height={768} loading="lazy" />;
  return <video src={LOOKS_DIR + clip} poster={src(id)} autoPlay muted loop playsInline preload="none" aria-label={`${alt} (AI-generated clip)`} />;
}

function FeatureUi({ kind }: { kind: string }) {
  if (kind === "golive") return <div className="fx fx-golive" data-ui aria-hidden="true"><span className="fx-dot" />Go live</div>;
  if (kind === "rec") return <div className="fx fx-rec" data-ui aria-hidden="true"><span className="fx-dot" />00:42</div>;
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
  const { index, pick } = useLookCycle();
  const heroClip = useClip("hero.mp4");
  const [stage, setStage] = useState(0);
  const [question, setQuestion] = useState(0);
  const [openRow, setOpenRow] = useState(0);
  useReveal();

  const current = index < 0 ? null : LOOKS[index];
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
            : <PixelFrame lookId={current ? current.id : CAMERA.id} label={current ? current.name : CAMERA.name} />}
          <div className="tile statement">
            <h1>Turn your webcam into anyone, live.</h1>
          </div>
        </div>
        <div className="rail-right">
          <p className="tile rr rr-1">Starts in seconds</p>
          <p className="tile rr rr-2">Talk, turn, laugh</p>
          <p className="tile rr rr-3">Record or stream</p>
          <p className="tile rr rr-4">A free live minute</p>
          <Link className="tile rr rr-action" to={primary.to}>{primary.label}<span aria-hidden="true">→</span></Link>
        </div>
      </header>

      <main>
        {/* Looks, set like a departure board. Opening a row also sends that look to the frame above. */}
        <section id="looks" className="looks" aria-labelledby="looks-title">
          <h2 id="looks-title" className="sr-only">Looks</h2>
          <div className="departures" data-ui>
            {LOOKS.map((look, i) => {
              const open = openRow === i;
              return (
                <button key={look.id} className={`dep${open ? " is-open" : ""}`} aria-expanded={open}
                  onClick={() => { setOpenRow(i); pick(i); document.querySelector(".hero")?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth" }); }}
                  onMouseEnter={() => setOpenRow(i)} onFocus={() => setOpenRow(i)}>
                  <img className="dep-thumb" src={src(look.id)} alt="" width={1376} height={768} loading="lazy" />
                  <span className="dep-name">{look.name}</span>
                  <span className="dep-src">{look.source}</span>
                  <span className="dep-prompt">“{look.prompt}”</span>
                  <span className="dep-status">Live</span>
                  {open && <span className="dep-detail">{look.detail} <u>Show it on the frame</u></span>}
                </button>
              );
            })}
          </div>
        </section>

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
            <div className="tile ftile t-6x2 f-head" data-reveal><h2 id="features-title">Made for calls and streams</h2></div>
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
            <p>Make an account, confirm your email and your first live minute is on us. Use it with your own face, or with someone's consent.</p>
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
