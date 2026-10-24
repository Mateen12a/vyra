import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PixelLoader, useToast } from "../components/ui";
import { api, LEDGER_LABELS, minutes, money, type Credits } from "../lib/api";
import { useAuth } from "../lib/auth";

export function CreditsPage() {
  const { me, refresh, setBalance } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<Credits | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [crediting, setCrediting] = useState(false);
  const [custom, setCustom] = useState("20");

  const load = () => api<Credits>("/api/credits").then((d) => { setData(d); setBalance(d.balance); }).catch((e) => toast(e.message, true));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Coming back from Stripe with the Back button restores this page from cache: clear the hand-off panel.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) setBuying(null); };
    addEventListener("pageshow", onShow);
    return () => removeEventListener("pageshow", onShow);
  }, []);

  // Back from Stripe: the webhook usually lands within seconds, so watch for the new balance.
  useEffect(() => {
    const status = params.get("checkout");
    if (!status) return;
    setParams({}, { replace: true });
    if (status === "cancelled") { toast("Checkout cancelled. No charge was made."); return; }
    setCrediting(true);
    const start = me?.balance ?? 0;
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      const next = await refresh();
      const added = Boolean(next && next.balance !== start);
      if (added || tries > 15) {
        clearInterval(timer); setCrediting(false); load();
        toast(added ? "Credits added. You're ready to go live." : "Payment received. Your credits can take a minute to appear; refresh shortly.");
      }
    }, 2000);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function buy(pack: string, amountUsd?: number) {
    setBuying(pack);
    try { const { url } = await api<{ url: string }>("/api/billing/checkout", { pack, ...(amountUsd ? { amount_usd: amountUsd } : {}) }); location.assign(url); }
    catch (err) { toast((err as Error).message, true); setBuying(null); }
  }

  if (!data || !me) return (
    <div className="page" aria-busy="true">
      <div className="sk sk-kicker" /><div className="sk sk-title" /><div className="sk sk-line" />
      <section className="packs" aria-label="Loading credit packs">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="pack pack-skeleton" style={{ animationDelay: `${i * 70}ms` }}><div className="sk sk-a" /><div className="sk sk-b" /><div className="sk sk-c" /></div>)}
      </section>
    </div>
  );
  const perMinute = data.live_credits_per_minute;
  const limits = data.custom || { min_usd: 5, max_usd: 5000 };
  const customUsd = Number(custom);
  const customOk = Number.isInteger(customUsd) && customUsd >= limits.min_usd && customUsd <= limits.max_usd;
  const customCredits = customOk ? Math.round(customUsd / data.credit_usd) : 0;
  const base = data.packs[0] ? data.packs[0].amount_cents / data.packs[0].credits : 0;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">Credits</p>
          <h1 className="page-title num">{data.balance.toLocaleString("en-US")} <span className="muted page-title-sub">credits · {minutes(data.balance, perMinute)} of live</span></h1>
        </div>
      </header>
      <p className="muted lead-line">1 credit is 1 second of live video. Credits never expire and work across every VYRANI tool. Bigger packs include more bonus time.</p>
      {!me.user.verified && <div className="alert alert-info">Verify your email before buying credits. Check your inbox for the link.</div>}
      {!data.payments && <div className="alert alert-info">Payments aren't switched on for this server yet.</div>}
      {crediting && <div className="crediting" role="status"><PixelLoader label="Adding your credits" /><div><strong>Payment received. Adding your credits…</strong><span className="muted">This usually takes a few seconds. You can stay on this page.</span></div></div>}
      {buying && (
        <div className="checkout-veil" role="dialog" aria-modal="true" aria-label="Opening checkout">
          <div className="checkout-card">
            <PixelLoader label="Opening checkout" />
            <p className="checkout-title">Opening secure checkout</p>
            <p className="muted">{buying === "custom" ? `Other amount · $${customUsd}` : `${data.packs.find((p) => p.id === buying)?.name} · ${money(data.packs.find((p) => p.id === buying)?.amount_cents || 0)}`}. You'll pay on Stripe and come straight back here.</p>
          </div>
        </div>
      )}

      <section className="packs" aria-label="Credit packs">
        {data.packs.map((pack) => {
          const bonus = base ? Math.round((pack.credits / (pack.amount_cents / base) - 1) * 100) : 0;
          return (
            <button key={pack.id} type="button" className={`pack${pack.id === "creator" ? " pack-featured" : ""}`} disabled={!!buying || !me.user.verified || !data.payments}
              onClick={() => buy(pack.id)}>
              <span className="pack-top"><span className="pack-name">{pack.name}</span>{bonus > 0 && <span className="pack-bonus">+{bonus}% time</span>}</span>
              <span className="pack-time num">{minutes(pack.credits, perMinute)}</span>
              <span className="pack-credits num">{pack.credits.toLocaleString("en-US")} credits</span>
              <span className="pack-price num">{money(pack.amount_cents)}</span>
            </button>
          );
        })}
        <form className="pack pack-custom" onSubmit={(e) => { e.preventDefault(); if (customOk) buy("custom", customUsd); }}>
          <span className="pack-top"><span className="pack-name">Other amount</span></span>
          <label className="pack-amount">
            <span aria-hidden="true">$</span>
            <input inputMode="numeric" pattern="[0-9]*" value={custom} aria-label={`Amount in US dollars, ${limits.min_usd} to ${limits.max_usd}`}
              onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))} />
          </label>
          <span className="pack-credits num">{customOk ? `${customCredits.toLocaleString("en-US")} credits · ${minutes(customCredits, perMinute)} of live`
            : `Whole dollars, $${limits.min_usd} to $${limits.max_usd.toLocaleString("en-US")}`}</span>
          <button type="submit" className="btn btn-primary btn-sm pack-buy" disabled={!customOk || !!buying || !me.user.verified || !data.payments}>Buy</button>
        </form>
      </section>
      <p className="dim small-line">Secure checkout by Stripe. One-off payments, no subscription.</p>

      <section className="card card-pad">
        <div className="section-head"><h2>History</h2></div>
        {data.history.length ? (
          <ul className="activity">
            {data.history.map((row, i) => (
              <li key={i}>
                <span>{LEDGER_LABELS[row.kind] || row.kind}{row.reason ? <span className="dim"> · {row.reason}</span> : null}</span>
                <span className="dim">{new Date(row.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                <span className={`num ${row.delta > 0 ? "plus" : "minus"}`}>{row.delta > 0 ? "+" : ""}{row.delta.toLocaleString("en-US")}</span>
              </li>
            ))}
          </ul>
        ) : <p className="muted">No activity yet.</p>}
      </section>
    </div>
  );
}
