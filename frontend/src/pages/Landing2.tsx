import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { TransformHero } from "../components/TransformHero";
import { StudioDemo } from "../components/StudioDemo";
import "../styles/landing2.css";

// The cinematic landing (preview at /preview). One idea, acted out by the page: your camera becomes someone else,
// pixel by pixel, as you scroll. Everything shown is real product output; the people are AI-generated and fictional.
const LOOKS = "/assets/site/looks/";
const SCREENS = "/assets/site/screens/";
const reduce = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const STATEMENT = "Most video calls show you exactly as you are. VYRANI lets you choose who shows up: a sharper look, a better room, or a different face, live, from one photo.";

const FAQ: [string, string][] = [
  ["Do I need to install anything?", "No. VYRANI runs in your browser with your own webcam. To use it inside video calls, add the free VYRANI extension for Chrome."],
  ["How real does it look?", "Very convincing in good, even light with your face clearly in view. Fast movement, hands across the face and dark rooms are where it slips, so the studio checks your light before you start."],
  ["Can I become a real person?", "Only yourself, an AI-made person, or someone who has agreed to it. Passing yourself off as someone else closes the account."],
  ["Is the video marked as AI?", "Yes. Every recording carries a tag that says it was made with AI, and live video can show a visible VYRANI label."],
  ["Does it work on my phone?", "Yes for making videos: film, choose who to become, add a voice, then share anywhere. Live calls work best on a laptop or desktop."],
  ["What does it cost?", "Your first account gets a free 30-second live trial after confirming its email. Plans and prices are shown once you sign in."],
];

// Lights the statement word by word as it scrolls through the screen.
function useWordReveal(count: number) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [lit, setLit] = useState(reduce() ? count : 0);
  useEffect(() => {
    if (reduce()) return;
    const on = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (innerHeight * 0.85 - r.top) / (r.height + innerHeight * 0.45)));
      setLit(Math.round(p * count));
    };
    on();
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, [count]);
  return { ref, lit };
}

// Sections rise in once as they enter. Content stays visible without script.
function useReveal() {
  useEffect(() => {
    if (reduce() || !("IntersectionObserver" in window)) return;
    const items = Array.from(document.querySelectorAll<HTMLElement>(".l2 [data-reveal]"));
    items.forEach((el) => el.classList.add("l2-wait"));
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.remove("l2-wait"); io.unobserve(e.target); }
    }), { rootMargin: "0px 0px -10% 0px" });
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function Chip({ p }: { p: number }) {
  const step = p < 0.04 ? 0 : p < 0.45 ? 1 : p < 0.88 ? 2 : 3;
  const text = ["Reading your face…", "Matching Tom's photo…", "Rendering live…", "Live · Mary as Tom"][step];
  return (
    <div className={`l2-chip${step === 3 ? " is-live" : ""}`} role="status" aria-live="polite">
      <span className="l2-chip-dot" aria-hidden="true" />
      <span><strong>VYRANI Studio</strong><span className="l2-chip-text">{text}</span></span>
    </div>
  );
}

export default function Landing2() {
  const { me } = useAuth();
  const primary = me ? { to: "/app/studio", label: "Open the studio" } : { to: "/signup", label: "Try it free" };
  const words = STATEMENT.split(" ");
  const { ref: statementRef, lit } = useWordReveal(words.length);
  const [solid, setSolid] = useState(false);
  useReveal();
  useEffect(() => {
    const on = () => setSolid(scrollY > innerHeight * 2.2);
    on(); addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);

  return (
    <div className="l2">
      <header className={`l2-nav${solid ? " is-solid" : ""}`}>
        <Link to="/" className="l2-brand" aria-label="VYRANI home"><img src="/assets/brand/vyrani-mark.svg" alt="" />VYRANI</Link>
        <nav aria-label="Sections"><a href="#how">How it works</a><a href="#looks">Looks</a><a href="#where">Where it works</a><a href="#faq">Questions</a></nav>
        <div className="l2-nav-actions">
          {!me && <Link to="/signin" className="l2-signin">Sign in</Link>}
          <Link to={primary.to} className="l2-btn l2-btn-sm">{primary.label}</Link>
        </div>
      </header>

      <TransformHero>
        {(p) => {
          const fade = 1 - Math.min(1, Math.max(0, (p - 0.35) / 0.3));
          const end = Math.min(1, Math.max(0, (p - 0.82) / 0.15));
          return (
            <>
              <Chip p={p} />
              <div className="l2-hero-copy" style={{ opacity: fade, transform: `translateY(${(1 - fade) * -40}px)` }}>
                <h1>Turn your webcam into anyone, live.</h1>
                <p>Type a look or add one photo. Your face, voice and every move drive it in real time, in your calls, streams and videos.</p>
                <div className="l2-ctas">
                  <Link to={primary.to} className="l2-btn">{primary.label} <span aria-hidden="true">→</span></Link>
                  <a href="#how" className="l2-btn l2-btn-ghost">See how it works</a>
                </div>
              </div>
              <p className="l2-end" style={{ opacity: end, transform: `translateY(${(1 - end) * 24}px)` }}>
                Mary on camera. <span>Tom on screen.</span> One photo.
              </p>
              <p className="l2-scroll" style={{ opacity: fade }} aria-hidden="true">Scroll to transform</p>
            </>
          );
        }}
      </TransformHero>

      <main>
        <section className="l2-light l2-statement-wrap" aria-label="Why VYRANI">
          <p ref={statementRef} className="l2-statement">
            {words.map((w, i) => <span key={i} className={i < lit ? "is-lit" : ""}>{w} </span>)}
          </p>
          <div className="l2-stats" data-reveal>
            <div className="l2-stat"><strong>1 photo</strong><span>is all it takes to become someone else, live.</span></div>
            <div className="l2-stat"><strong>5 call apps</strong><span>Meet, WhatsApp Web, Zoom, Teams and Discord in Chrome.</span></div>
            <div className="l2-stat"><strong>30 s free</strong><span>live trial for your first account. No card needed.</span></div>
            <div className="l2-stat"><strong>AI-marked</strong><span>every recording carries a tag; live video can show a label.</span></div>
          </div>
        </section>

        <section id="how" className="l2-light l2-how" aria-labelledby="how-title">
          <h2 id="how-title" data-reveal>Three steps. About a minute.</h2>
          <div className="l2-steps">
            <article className="l2-step" data-reveal>
              <div className="l2-step-media l2-step-photo">
                <img src={`${LOOKS}ref-man.jpg`} alt="A reference photo of Tom, an AI-made person" />
                <span className="l2-step-tag">or type “in a charcoal blazer”</span>
              </div>
              <h3>Choose who shows up</h3>
              <p>Add one clear photo, or describe a look in a few words. VYRANI writes the details for you.</p>
            </article>
            <article className="l2-step" data-reveal>
              <div className="l2-step-media"><StudioDemo variant="pip" look={0} className="l2-demo" /></div>
              <h3>Press Go live</h3>
              <p>Talk, smile and move. The new look follows your face and voice, live, and you can switch any time.</p>
            </article>
            <article className="l2-step" data-reveal>
              <div className="l2-step-media l2-step-apps" aria-hidden="true">
                {["Google Meet", "WhatsApp Web", "Zoom", "Teams", "Discord", "YouTube Live", "Twitch", "Facebook Live"].map((a) => <span key={a}>{a}</span>)}
              </div>
              <h3>Show up anywhere</h3>
              <p>Pick VYRANI as your camera in calls, stream it out, or record and post the video.</p>
            </article>
          </div>
        </section>

        <section className="l2-dark l2-screens" aria-labelledby="screens-title">
          <div className="l2-screens-head" data-reveal>
            <h2 id="screens-title">See the real thing.</h2>
            <p>Drag the line to compare the camera with the live result.</p>
          </div>
          <div className="l2-rail" data-reveal>
            <figure className="l2-card l2-card-wide"><StudioDemo variant="split" look={1} /><figcaption><strong>Live studio</strong>Mark on camera, Gwen on screen, from one photo.</figcaption></figure>
            <figure className="l2-card l2-card-phone"><div className="l2-shot"><img src={`${SCREENS}create-phone.jpg`} alt="Screenshot: Create video on a phone, with a clip, a photo of who to become and a voice" style={{ objectPosition: "50% 36%" }} /></div><figcaption><strong>Create on your phone</strong>Film, pick who to become, add a voice. Share anywhere.</figcaption></figure>
            <figure className="l2-card l2-card-phone"><div className="l2-shot"><img src={`${SCREENS}consent-phone.jpg`} alt="Screenshot: the consent promise shown before the first video" style={{ objectPosition: "50% 50%" }} /></div><figcaption><strong>Consent, built in</strong>A one-time promise before anyone goes live.</figcaption></figure>
          </div>
          <p className="l2-note">Actual product screens. The people shown are AI-generated and fictional.</p>
        </section>

        <section id="looks" className="l2-light l2-looks" aria-labelledby="looks-title">
          <div className="l2-looks-head" data-reveal>
            <h2 id="looks-title">Your good day, every call.</h2>
            <p>Everyday looks from one line of text. Still your face, still your expressions.</p>
          </div>
          <div className="l2-looks-grid">
            <figure className="l2-look l2-look-big" data-reveal>
              <video src={`${LOOKS}swap-b.mp4`} poster={`${LOOKS}swap-b.jpg`} autoPlay muted loop playsInline aria-label="Mark on a work call, replaced by Gwen from one photo" />
              <figcaption>A different person · <span>from one photo</span></figcaption>
            </figure>
            {[["interview", "Interview ready"], ["studio", "Better background"], ["creator", "Creator setup"], ["glam", "Hair and makeup"]].map(([id, label]) => (
              <figure key={id} className="l2-look" data-reveal>
                <img src={`${LOOKS}${id}.jpg`} alt={`The same woman: ${label.toLowerCase()}`} />
                <figcaption>{label}</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section id="where" className="l2-light l2-where" aria-labelledby="where-title">
          <h2 id="where-title" data-reveal>Where it works</h2>
          <div className="l2-where-grid">
            <div data-reveal><h3>In video calls</h3><p>Google Meet, WhatsApp Web, Zoom, Microsoft Teams and Discord, with the free Chrome extension.</p></div>
            <div data-reveal><h3>In live streams</h3><p>YouTube, Twitch, Facebook Live, Kick and more with your stream key, straight from the studio.</p></div>
            <div data-reveal><h3>On your phone</h3><p>Make the video on VYRANI, then post it anywhere: WhatsApp, Instagram, TikTok, Snapchat.</p></div>
          </div>
        </section>

        <section id="faq" className="l2-light l2-faq" aria-labelledby="faq-title">
          <h2 id="faq-title" data-reveal>Questions</h2>
          <div className="l2-faq-list">
            {FAQ.map(([q, a], i) => (
              <details key={q} open={i === 0} data-reveal><summary>{q}</summary><p>{a}</p></details>
            ))}
          </div>
        </section>

        <section className="l2-close" aria-labelledby="close-title">
          <div className="l2-close-panel" data-reveal>
            <img className="l2-close-mark" src="/assets/brand/vyrani-mark.svg" alt="" />
            <h2 id="close-title">Who will you be today?</h2>
            <p>Make an account, confirm your email, and your first 30 seconds live are on us.</p>
            <Link to={primary.to} className="l2-btn">{primary.label} <span aria-hidden="true">→</span></Link>
          </div>
        </section>
      </main>

      <footer className="l2-foot">
        <Link to="/" className="l2-brand"><img src="/assets/brand/vyrani-mark.svg" alt="" />VYRANI</Link>
        <nav aria-label="Footer"><a href="#how">How it works</a><a href="#looks">Looks</a><a href="#faq">Questions</a><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link></nav>
        <p>© 2026 Vyrani Studios · Use VYRANI only with your own face, an AI-made person's, or with consent.</p>
      </footer>
    </div>
  );
}
