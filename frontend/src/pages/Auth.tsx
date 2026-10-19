import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Field, Spinner, Wordmark } from "../components/ui";
import { api, EMAIL_RE, MIN_PASSWORD } from "../lib/api";
import { useAuth } from "../lib/auth";

// Split layout: the form on the left, a quiet statement about the product on the right.
function AuthLayout({ title, lead, children }: { title: string; lead: ReactNode; children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-form-side">
        <div className="auth-top"><Wordmark /></div>
        <div className="auth-box">
          <h1 className="auth-title">{title}</h1>
          <p className="auth-lead">{lead}</p>
          {children}
        </div>
        <p className="auth-foot dim">Use VYRA only with the consent of anyone shown.</p>
      </div>
      <div className="auth-art" aria-hidden="true">
        <div className="auth-art-frame">
          <div className="auth-art-badge"><span className="live-dot" /> Live</div>
          <p className="auth-art-quote">Your camera, any character. Changed as you move.</p>
          <div className="auth-art-steps">
            <span>Photo or idea</span><span className="auth-art-arrow">→</span><span>Go live</span><span className="auth-art-arrow">→</span><span>Record or stream</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function useGoogle() {
  const [google, setGoogle] = useState(false);
  useEffect(() => { api<{ google: boolean }>("/api/auth/providers").then((p) => setGoogle(p.google)).catch(() => {}); }, []);
  return google;
}

function GoogleButton() {
  return (
    <>
      <a className="btn btn-light btn-lg btn-block google" href="/api/auth/google/start">
        <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
        Continue with Google
      </a>
      <p className="auth-or"><span>or with email</span></p>
    </>
  );
}

const emailError = (v: string) => (!v.trim() ? "Enter your email." : EMAIL_RE.test(v.trim()) ? "" : "That email doesn't look right. Check for typos.");

export function SignIn() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const google = useGoogle();
  const [email, setEmail] = useState(params.get("email") || "");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState(params.get("auth_error") === "cancelled" ? "Google sign-in was cancelled."
    : params.get("auth_error") ? "Google sign-in didn't work. Try again or use your email." : "");
  const [busy, setBusy] = useState(false);
  const errors = { email: emailError(email), password: password ? "" : "Enter your password." };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (errors.email || errors.password) return;
    setBusy(true); setError("");
    try {
      await api("/api/auth/login", { email: email.trim(), password });
      await refresh();
      navigate(params.get("next") || "/app", { replace: true });
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <AuthLayout title="Welcome back" lead={<>New to VYRA? <Link to="/signup">Create an account</Link></>}>
      {google && <GoogleButton />}
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field label="Email" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, email: true }))} error={touched.email ? errors.email : ""} />
        <Field label="Password" reveal autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, password: true }))} error={touched.password ? errors.password : ""} />
        <Link className="auth-link-right" to={`/forgot${email ? `?email=${encodeURIComponent(email)}` : ""}`}>Forgot password?</Link>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? <><Spinner /> Signing in</> : "Sign in"}</button>
      </form>
    </AuthLayout>
  );
}

export function SignUp() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const google = useGoogle();
  const [email, setEmail] = useState(params.get("email") || "");
  const [password, setPassword] = useState("");
  const [agree, setAgree] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const errors = {
    email: emailError(email),
    password: !password ? "Choose a password." : password.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters (${password.length} so far).` : "",
    agree: agree ? "" : "Please confirm before continuing.",
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched({ email: true, password: true, agree: true });
    if (errors.email || errors.password || errors.agree) return;
    setBusy(true); setError("");
    try {
      await api("/api/auth/signup", { email: email.trim(), password });
      await refresh();
      navigate("/app?welcome=1", { replace: true });
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <AuthLayout title="Create your account" lead={<>Already have one? <Link to="/signin">Sign in</Link></>}>
      {google && <GoogleButton />}
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field label="Email" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, email: true }))} error={touched.email ? errors.email : ""} />
        <Field label="Password" reveal autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, password: true }))} error={touched.password ? errors.password : ""}
          help={`At least ${MIN_PASSWORD} characters. A short phrase is easiest to remember.`} />
        <label className="check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>I'll only transform myself, or people who have agreed to it.</span>
        </label>
        {touched.agree && errors.agree && <small className="field-error">{errors.agree}</small>}
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? <><Spinner /> Creating account</> : "Create account"}</button>
      </form>
    </AuthLayout>
  );
}

export function Forgot() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") || "");
  const [touched, setTouched] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (emailError(email)) return;
    setBusy(true); setError("");
    try { await api("/api/auth/reset/request", { email: email.trim() }); setSent(true); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <AuthLayout title="Reset your password" lead={<>Remembered it? <Link to="/signin">Sign in</Link></>}>
      {sent ? (
        <div className="alert alert-ok" role="status">If {email.trim()} has an account, a reset link is on its way. It works for one hour.</div>
      ) : (
        <form className="auth-form" onSubmit={submit} noValidate>
          <Field label="Email" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched(true)} error={touched ? emailError(email) : ""} />
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? <><Spinner /> Sending</> : "Send reset link"}</button>
        </form>
      )}
    </AuthLayout>
  );
}

export function Reset() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const token = params.get("token") || params.get("reset") || "";
  const problem = password.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters (${password.length} so far).` : "";
  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (problem) return;
    setBusy(true); setError("");
    try { await api("/api/auth/reset", { token, password }); navigate("/signin?reset=done", { replace: true }); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <AuthLayout title="Choose a new password" lead="You'll be signed out on every other device.">
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field label="New password" reveal autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched(true)} error={touched ? problem : ""} />
        {!token && <div className="alert alert-error">This link is incomplete. Open the newest email we sent you.</div>}
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !token}>{busy ? <><Spinner /> Saving</> : "Save password"}</button>
      </form>
    </AuthLayout>
  );
}

export function Verify() {
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [message, setMessage] = useState("");
  const started = useRef(false); // the token is single use; never send it twice
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = params.get("token") || params.get("verify") || "";
    api("/api/auth/verify", { token })
      .then(() => { setState("done"); refresh(); })
      .catch((err) => { setState("failed"); setMessage((err as Error).message); });
  }, [params, refresh]);
  return (
    <AuthLayout title={state === "done" ? "Email verified" : state === "failed" ? "That link didn't work" : "Verifying"}
      lead={state === "done" ? "Your free minute of live is in your balance." : state === "failed" ? message : "One moment."}>
      {state === "working" ? <Spinner /> : <Link className="btn btn-primary btn-lg btn-block" to="/app">Go to VYRA</Link>}
    </AuthLayout>
  );
}
