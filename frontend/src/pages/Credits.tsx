import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Spinner, useToast } from "../components/ui";
import { api, LEDGER_LABELS, minutes, money, type Credits } from "../lib/api";
import { useAuth } from "../lib/auth";

export function CreditsPage() {
  const { me, refresh, setBalance } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<Credits | null>(null);
  const [buying, setBuying] = useState<string | null>(null);

  const load = () => api<Credits>("/api/credits").then((d) => { setData(d); setBalance(d.balance); }).catch((e) => toast(e.message, true));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from Stripe: the webhook usually lands within seconds, so watch for the new balance.
  useEffect(() => {
    const status = params.get("checkout");
    if (!status) return;
    setParams({}, { replace: true });
    if (status === "cancelled") { toast("Checkout cancelled. No charge was made."); return; }
    toast("Payment received. Adding your credits…");
    const start = me?.balance ?? 0;
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      const next = await refresh();
      if ((next && next.balance !== start) || tries > 10) { clearInterval(timer); load(); if (next && next.balance !== start) toast("Credits added."); }
    }, 2000);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function buy(pack: string) {
    setBuying(pack);
    try { const { url } = await api<{ url: string }>("/api/billing/checkout", { pack }); location.assign(url); }
    catch (err) { toast((err as Error).message, true); setBuying(null); }
  }

  if (!data || !me) return <div className="page"><Spinner /></div>;
  const perMinute = data.live_credits_per_minute;
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

      <section className="packs" aria-label="Credit packs">
        {data.packs.map((pack) => {
          const bonus = base ? Math.round((pack.credits / (pack.amount_cents / base) - 1) * 100) : 0;
          return (
            <button key={pack.id} type="button" className={`pack${pack.id === "creator" ? " pack-featured" : ""}`} disabled={!!buying || !me.user.verified || !data.payments}
              onClick={() => buy(pack.id)}>
              <span className="pack-top"><span className="pack-name">{pack.name}</span>{bonus > 0 && <span className="pack-bonus">+{bonus}% time</span>}</span>
              <span className="pack-time num">{minutes(pack.credits, perMinute)}</span>
              <span className="pack-credits num">{pack.credits.toLocaleString("en-US")} credits</span>
              <span className="pack-price num">{buying === pack.id ? <Spinner /> : money(pack.amount_cents)}</span>
            </button>
          );
        })}
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
