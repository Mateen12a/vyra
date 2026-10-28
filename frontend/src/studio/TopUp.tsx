import { useEffect, useState } from "react";
import { Dialog } from "../components/ui";
import { api, minutes, money, type Catalogue } from "../lib/api";

const SHOWN = ["starter", "p50", "creator"]; // a small, middle and big choice; the middle one is highlighted

export type TopUpReason = "empty" | "low" | "ended";

const HEADLINES: Record<TopUpReason, { title: string; lead: string }> = {
  empty: { title: "Top up to go live", lead: "You need at least 30 seconds of credit to start. Pick a pack and you'll be back in under a minute." },
  low: { title: "Running low on time", lead: "Under a minute left. Top up now so your call doesn't cut to a dark screen mid-sentence." },
  ended: { title: "Your time ran out", lead: "Your call is showing a dark screen. Top up and press Go live to pick up right where you left off." },
};

/** A short, friendly top-up prompt: the result people get, three packs, one tap to Stripe. */
export function TopUp({ reason, onClose }: { reason: TopUpReason; onClose: () => void }) {
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<Catalogue>("/api/pricing").then(setCat).catch(() => setError("Couldn't load prices. Open Credits instead.")); }, []);

  async function buy(pack: string) {
    setBuying(pack); setError("");
    try { const { url } = await api<{ url: string }>("/api/billing/checkout", { pack }); location.assign(url); }
    catch (err) { setError((err as Error).message); setBuying(null); }
  }

  const perMinute = cat?.live_credits_per_minute || 60;
  const all = cat?.packs || [];
  const packs = SHOWN.map((id) => all.find((p) => p.id === id)).filter((p) => p !== undefined);
  const base = all[0] ? all[0].amount_cents / all[0].credits : 0;
  const { title, lead } = HEADLINES[reason];
  return (
    <Dialog title={title} onClose={onClose} wide>
      <div className="topup">
        <figure className="topup-demo">
          <img src="/assets/site/looks/pair-a.jpg" alt="A real webcam frame next to the same frame as a different person, made live by VYRANI" />
          <figcaption><span>Your camera</span><span>Live on your call</span></figcaption>
        </figure>
        <p className="topup-lead">{lead}</p>
        <div className="topup-packs">
          {packs.map((pack) => {
            const bonus = base ? Math.round((pack.credits / (pack.amount_cents / base) - 1) * 100) : 0;
            const best = pack.id === "p50";
            return (
              <button key={pack.id} type="button" className={`topup-pack${best ? " best" : ""}`} disabled={!!buying} onClick={() => buy(pack.id)}>
                {best && <span className="topup-tag">Most popular</span>}
                <strong className="num">{minutes(pack.credits, perMinute)}</strong>
                <span className="muted">of live video{bonus > 0 ? ` · +${bonus}% free` : ""}</span>
                <span className="topup-price num">{buying === pack.id ? "Opening…" : money(pack.amount_cents)}</span>
              </button>
            );
          })}
        </div>
        {error && <p className="error-line">{error}</p>}
        <p className="dim small-line">Secure checkout by Stripe · one-off payment · credits never expire · no watermark once you've bought. <a href="/app/credits">More amounts</a></p>
      </div>
    </Dialog>
  );
}
