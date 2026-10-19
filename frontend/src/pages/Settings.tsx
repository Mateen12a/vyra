import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

export function Settings() {
  const { me, signOut } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [sent, setSent] = useState(false);
  if (!me) return null;
  const u = me.user;

  async function sendReset() {
    try { await api("/api/auth/reset/request", { email: u.email }); setSent(true); toast("Check your inbox for a link to set your password."); }
    catch (err) { toast((err as Error).message, true); }
  }
  async function resend() {
    try { await api("/api/auth/resend", {}); toast("Verification email sent."); }
    catch (err) { toast((err as Error).message, true); }
  }

  return (
    <div className="page page-narrow">
      <header className="page-head"><div><p className="kicker">Settings</p><h1 className="page-title">Your account</h1></div></header>
      <section className="card settings">
        <div className="setting">
          <div><h2>Email</h2><p className="muted">{u.email}</p></div>
          {u.verified ? <span className="pill pill-ok">Verified</span> : <button className="btn btn-sm btn-ghost" onClick={resend}>Verify email</button>}
        </div>
        <div className="setting">
          <div><h2>Sign-in methods</h2><p className="muted">{[u.has_password && "Password", u.google && "Google"].filter(Boolean).join(" and ") || "None"}</p></div>
        </div>
        <div className="setting">
          <div><h2>{u.has_password ? "Change password" : "Add a password"}</h2><p className="muted">We'll email you a secure link. It works for one hour.</p></div>
          <button className="btn btn-sm btn-ghost" onClick={sendReset} disabled={sent}>{sent ? "Link sent" : "Email me a link"}</button>
        </div>
        <div className="setting">
          <div><h2>Sign out</h2><p className="muted">Ends this session on this device.</p></div>
          <button className="btn btn-sm btn-ghost" onClick={async () => { await signOut(); navigate("/", { replace: true }); }}>Sign out</button>
        </div>
      </section>
      <p className="dim small-line">Use VYRA only with the consent of anyone shown. Recordings carry a hidden tag that marks them as made with AI.</p>
    </div>
  );
}
