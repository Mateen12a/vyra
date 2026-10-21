import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Dialog, Spinner, useToast } from "../components/ui";
import { api, LEDGER_LABELS, type LedgerRow } from "../lib/api";

type Stats = { users: number; verified: number; revenue_cents: number; purchases: number; credits_sold: number;
  credits_outstanding: number; live_minutes: number; live_now: number };
type AdminUser = { id: string; email: string; role: "user" | "admin"; verified: boolean; balance: number };
type Provider = { fal_balance: number | null; min_live: number; min_clip: number; alert_below: number; accepting_live: boolean; accepting_clips: boolean };
type LiveRow = { id: string; email: string; state: string; provider: string | null; started_at: string; paid_seconds: number; used_seconds: number | null };

const num = (n: number) => Number(n || 0).toLocaleString("en-US");
const secs = (s: number | null) => (s == null ? "–" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

export default function Admin() {
  const toast = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [live, setLive] = useState<LiveRow[]>([]);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<AdminUser | null>(null);

  const loadStats = useCallback(() => api<Stats>("/api/admin/stats").then(setStats).catch((e) => toast(e.message, true)), [toast]);
  const loadUsers = useCallback((q: string) => api<AdminUser[]>(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(setUsers)
    .catch((e) => toast(e.message, true)), [toast]);
  const loadLive = useCallback(() => api<LiveRow[]>("/api/admin/live").then(setLive).catch(() => {}), []);

  const loadProvider = useCallback(() => api<Provider>("/api/admin/provider").then(setProvider).catch(() => {}), []);
  useEffect(() => { loadStats(); loadLive(); loadProvider(); }, [loadStats, loadLive, loadProvider]);
  useEffect(() => { const t = setTimeout(() => loadUsers(query.trim()), 250); return () => clearTimeout(t); }, [query, loadUsers]);

  return (
    <div className="page">
      <header className="page-head"><div><p className="kicker">Admin</p><h1 className="page-title">Overview</h1></div>
        <button className="btn btn-ghost" onClick={() => { loadStats(); loadLive(); loadProvider(); loadUsers(query.trim()); }}>Refresh</button></header>
      {provider && (
        <div className={`alert ${provider.fal_balance == null ? "alert-info" : !provider.accepting_live ? "alert-error" : provider.fal_balance < provider.alert_below ? "alert-info" : "alert-ok"}`}>
          <strong>fal balance: {provider.fal_balance == null ? "unknown" : `$${provider.fal_balance.toFixed(2)}`}</strong>{" "}
          {provider.fal_balance == null ? "Couldn't read it right now."
            : !provider.accepting_live ? `New live sessions are paused (below $${provider.min_live.toFixed(2)}); users see "very busy, try again". Top up now.`
            : provider.fal_balance < provider.alert_below ? `Below $${provider.alert_below.toFixed(0)}: top up soon. Live pauses below $${provider.min_live.toFixed(2)}.`
            : "Healthy."}{" "}
          <a href="https://fal.ai/dashboard/billing" target="_blank" rel="noreferrer">Open fal billing</a>
        </div>
      )}
      <section className="stat-row stat-row-4">
        <div className="stat"><span className="stat-label">Revenue</span><strong className="stat-value num">{stats ? `$${num(stats.revenue_cents / 100)}` : "–"}</strong><span className="muted">{stats ? `${num(stats.purchases)} purchases` : ""}</span></div>
        <div className="stat"><span className="stat-label">Users</span><strong className="stat-value num">{stats ? num(stats.users) : "–"}</strong><span className="muted">{stats ? `${num(stats.verified)} verified` : ""}</span></div>
        <div className="stat"><span className="stat-label">Live minutes used</span><strong className="stat-value num">{stats ? num(stats.live_minutes) : "–"}</strong><span className="muted">{stats ? `${stats.live_now} live now` : ""}</span></div>
        <div className="stat"><span className="stat-label">Credits outstanding</span><strong className="stat-value num">{stats ? num(stats.credits_outstanding) : "–"}</strong><span className="muted">{stats ? `${num(stats.credits_sold)} sold` : ""}</span></div>
      </section>

      <section className="card">
        <div className="table-head"><h2>Users</h2>
          <input className="input input-sm" type="search" placeholder="Search by email" aria-label="Search users by email" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Email</th><th>Role</th><th>Verified</th><th className="right">Credits</th><th /></tr></thead>
            <tbody>{users.map((u) => (
              <tr key={u.id}><td>{u.email}</td><td>{u.role}</td><td>{u.verified ? "Yes" : "No"}</td><td className="right num">{num(u.balance)}</td>
                <td className="right"><button className="btn btn-sm btn-ghost" onClick={() => setOpen(u)}>Manage</button></td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="table-head"><h2>Live sessions</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>User</th><th>State</th><th>Engine</th><th>Started</th><th className="right">Paid</th><th className="right">Used</th></tr></thead>
            <tbody>{live.length ? live.map((r) => (
              <tr key={r.id}><td>{r.email}</td><td><span className={`pill${r.state === "live" ? " pill-ok" : ""}`}>{r.state}</span></td><td>{r.provider || "–"}</td>
                <td>{when(r.started_at)}</td><td className="right num">{secs(r.paid_seconds)}</td><td className="right num">{secs(r.used_seconds)}</td></tr>
            )) : <tr><td colSpan={6} className="muted">No sessions yet.</td></tr>}</tbody>
          </table>
        </div>
      </section>

      {open && <ManageUser user={open} onClose={() => setOpen(null)} onChanged={() => { loadUsers(query.trim()); loadStats(); }} />}
    </div>
  );
}

function ManageUser({ user, onClose, onChanged }: { user: AdminUser; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [balance, setBalance] = useState(user.balance);
  const [role, setRole] = useState(user.role);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<LedgerRow[]>(`/api/admin/users/${user.id}/ledger`).then(setLedger).catch(() => setLedger([])), [user.id]);
  useEffect(() => { load(); }, [load]);

  async function grant(e: FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (!Number.isInteger(value) || value === 0 || !reason.trim()) { toast("Enter a whole, non-zero amount and a reason.", true); return; }
    setBusy(true);
    try {
      // A fresh key per submit, so a double click can't apply the same adjustment twice.
      const key = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
      const result = await api<{ balance: number }>(`/api/admin/users/${user.id}/credits`, { amount: value, reason: reason.trim(), key });
      setBalance(result.balance); setAmount(""); setReason(""); load(); onChanged(); toast("Balance updated.");
    } catch (err) { toast((err as Error).message, true); }
    finally { setBusy(false); }
  }
  async function changeRole(next: "user" | "admin") {
    try { await api(`/api/admin/users/${user.id}/role`, { role: next }); setRole(next); onChanged(); toast(`Role set to ${next}.`); }
    catch (err) { toast((err as Error).message, true); }
  }

  return (
    <Dialog title={user.email} onClose={onClose}>
      <p className="muted num">{num(balance)} credits</p>
      <form className="grant" onSubmit={grant}>
        <input className="input" type="number" step="1" placeholder="Credits (negative to remove)" aria-label="Credit amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <input className="input" type="text" maxLength={200} placeholder="Reason, e.g. support refund" aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : "Apply"}</button>
      </form>
      <div className="setting setting-inline">
        <span>Role</span>
        <select className="input input-sm" value={role} onChange={(e) => changeRole(e.target.value as "user" | "admin")} aria-label="Role">
          <option value="user">user</option><option value="admin">admin</option>
        </select>
      </div>
      <h3 className="dialog-sub">Ledger</h3>
      {!ledger ? <Spinner /> : (
        <ul className="activity activity-tight">
          {ledger.map((row, i) => (
            <li key={i}><span>{LEDGER_LABELS[row.kind] || row.kind}{row.reason ? <span className="dim"> · {row.reason}</span> : null}</span>
              <span className="dim">{when(row.at)}</span><span className={`num ${row.delta > 0 ? "plus" : "minus"}`}>{row.delta > 0 ? "+" : ""}{num(row.delta)}</span></li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
