import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ImageIcon, StudioIcon, BroadcastIcon, useToast } from "../components/ui";
import { api, LEDGER_LABELS, minutes, type Credits } from "../lib/api";
import { useAuth } from "../lib/auth";

export function Dashboard() {
  const { me, catalogue, refresh } = useAuth();
  const toast = useToast();
  const [params] = useSearchParams();
  const [credits, setCredits] = useState<Credits | null>(null);
  const [resent, setResent] = useState(false);

  useEffect(() => { api<Credits>("/api/credits").then(setCredits).catch(() => {}); refresh(); }, [refresh]);
  if (!me) return null;
  const perMinute = catalogue?.live_credits_per_minute || 60;
  const low = me.balance < perMinute;
  const name = me.user.email.split("@")[0];
  const liveSeconds = (credits?.history || []).filter((r) => r.kind === "live" || r.kind === "live_refund").reduce((s, r) => s - r.delta, 0);

  async function resend() {
    try { await api("/api/auth/resend", {}); setResent(true); toast("Verification email sent."); }
    catch (err) { toast((err as Error).message, true); }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">{params.get("welcome") ? "Welcome to VYRA" : "Welcome back"}</p>
          <h1 className="page-title">Hi, {name}</h1>
        </div>
        <Link className="btn btn-primary btn-lg" to="/app/studio"><StudioIcon /> Open studio</Link>
      </header>

      {!me.user.verified && (
        <div className="banner">
          <div><strong>Verify your email to get a free minute.</strong> <span className="muted">We sent a link to {me.user.email}.</span></div>
          <button className="btn btn-sm btn-ghost" onClick={resend} disabled={resent}>{resent ? "Sent" : "Resend email"}</button>
        </div>
      )}

      <section className="start-grid" aria-label="Start">
        <Link className="start-card start-card-main" to="/app/studio?mode=photo">
          <span className="start-icon"><ImageIcon /></span>
          <h2>Become someone from a photo</h2>
          <p className="muted">Upload one clear photo of a character. VYRA maps it onto you while you talk and move.</p>
          <span className="start-go">Start →</span>
        </Link>
        <Link className="start-card" to="/app/studio?mode=describe">
          <span className="start-icon"><BroadcastIcon /></span>
          <h2>Describe a look</h2>
          <p className="muted">"A 1920s jazz singer", "ice queen", "in a tuxedo". VYRA writes the details for you.</p>
          <span className="start-go">Start →</span>
        </Link>
      </section>

      <section className="stat-row" aria-label="Your account">
        <div className={`stat${low ? " stat-low" : ""}`}>
          <span className="stat-label">Balance</span>
          <strong className="stat-value num">{me.balance.toLocaleString("en-US")}</strong>
          <span className="muted num">{minutes(me.balance, perMinute)} of live</span>
          <Link className="btn btn-sm btn-ghost stat-action" to="/app/credits">{low ? "Add credits" : "Buy more"}</Link>
        </div>
        <div className="stat">
          <span className="stat-label">Live time used</span>
          <strong className="stat-value num">{minutes(Math.max(0, liveSeconds), 60)}</strong>
          <span className="muted">across recent sessions</span>
        </div>
        <div className="stat">
          <span className="stat-label">Rate</span>
          <strong className="stat-value num">{perMinute}</strong>
          <span className="muted">credits per minute of live</span>
        </div>
      </section>

      <section className="card card-pad">
        <div className="section-head"><h2>Recent activity</h2><Link to="/app/credits" className="muted">See all</Link></div>
        {credits && credits.history.length ? (
          <ul className="activity">
            {credits.history.slice(0, 6).map((row, i) => (
              <li key={i}>
                <span>{LEDGER_LABELS[row.kind] || row.kind}</span>
                <span className="dim">{new Date(row.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                <span className={`num ${row.delta > 0 ? "plus" : "minus"}`}>{row.delta > 0 ? "+" : ""}{row.delta.toLocaleString("en-US")}</span>
              </li>
            ))}
          </ul>
        ) : <p className="muted">Nothing yet. Your first session will show up here.</p>}
      </section>
    </div>
  );
}
