import { useCallback, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Dialog } from "./ui";

// The once-per-account consent confirmation before the first live session or video. Email sign-ups confirm on the
// sign-up form; Google sign-ups and older accounts see this once. The server enforces it too (HTTP 428).
export function useConsentGate() {
  const { me, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const ensure = useCallback((): Promise<boolean> => {
    if (!me || me.user.consented) return Promise.resolve(true);
    setOpen(true);
    return new Promise((resolve) => { pending.current = resolve; });
  }, [me]);

  function close(ok: boolean) {
    setOpen(false);
    pending.current?.(ok);
    pending.current = null;
  }

  async function agree() {
    setBusy(true);
    try { await api("/api/account/consent", {}); await refresh(); close(true); }
    catch { close(false); }
    finally { setBusy(false); }
  }

  const dialog = open ? (
    <Dialog title="One quick promise" onClose={() => close(false)}>
      <div className="consent">
        <p>VYRANI can make you look and sound like someone else. Before you start, please confirm:</p>
        <p className="consent-promise">I'll only use my own face and voice, an AI-made person's, or those of someone who has agreed to it.
          I won't use VYRANI to deceive, scam or harass anyone.</p>
        <p className="muted">You only need to do this once. <Link to="/terms" target="_blank">Read the Terms</Link></p>
        <div className="consent-actions">
          <button type="button" className="btn btn-ghost" onClick={() => close(false)}>Not now</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={agree}>{busy ? "Saving…" : "I agree"}</button>
        </div>
      </div>
    </Dialog>
  ) : null;

  return { ensure, dialog };
}
