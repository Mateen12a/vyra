import { createContext, useCallback, useContext, useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router-dom";

export function Wordmark({ to = "/" }: { to?: string }) {
  return (
    <Link className="wordmark" to={to} aria-label="VYRA AI home">
      <span className="wordmark-dot" aria-hidden="true" />VYRA
    </Link>
  );
}

export const Spinner = () => <span className="spinner" aria-hidden="true" />;

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; help?: string; reveal?: boolean };

// A labelled input with its own error line. `reveal` adds a show/hide toggle for passwords.
export function Field({ label, error, help, reveal, id, type, ...rest }: FieldProps) {
  const [shown, setShown] = useState(false);
  const fieldId = id || `f-${label.toLowerCase().replace(/\W+/g, "-")}`;
  const describedBy = [help && `${fieldId}-help`, error && `${fieldId}-error`].filter(Boolean).join(" ") || undefined;
  const input = (
    <input id={fieldId} className="input" type={reveal ? (shown ? "text" : "password") : type} aria-invalid={error ? true : undefined}
      aria-describedby={describedBy} {...rest} />
  );
  return (
    <div className="field">
      <label className="field-label" htmlFor={fieldId}>{label}</label>
      {reveal ? (
        <div className="input-wrap">
          {input}
          <button type="button" className="reveal" aria-pressed={shown} aria-label={shown ? "Hide password" : "Show password"}
            onClick={() => setShown((s) => !s)}>{shown ? "Hide" : "Show"}</button>
        </div>
      ) : input}
      {help && !error && <small id={`${fieldId}-help`} className="field-help">{help}</small>}
      {error && <small id={`${fieldId}-error`} className="field-error">{error}</small>}
    </div>
  );
}

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, a, input")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => { removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`dialog${wide ? " dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><CloseIcon /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- toasts ----------
type Toast = { id: number; text: string; error?: boolean };
const ToastContext = createContext<(text: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, text, error }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), error ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast${t.error ? " toast-error" : ""}`}>{t.text}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

// ---------- icons (inline, 20px, stroke) ----------
const Svg = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
export const CloseIcon = () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const HomeIcon = () => <Svg><path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" /></Svg>;
export const StudioIcon = () => <Svg><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3" /></Svg>;
export const CreditIcon = () => <Svg><circle cx="12" cy="12" r="8" /><path d="M12 8v8M9 10.5h4.5a1.5 1.5 0 0 1 0 3H9" /></Svg>;
export const SettingsIcon = () => <Svg><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></Svg>;
export const ShieldIcon = () => <Svg><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /></Svg>;
export const PlusIcon = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>;
export const MirrorIcon = () => <Svg><path d="M12 4v16M8 8l-4 4 4 4M16 8l4 4-4 4" /></Svg>;
export const RecordIcon = () => <Svg><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="3" fill="currentColor" /></Svg>;
export const ExpandIcon = () => <Svg><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Svg>;
export const ImageIcon = () => <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-8 9" /></Svg>;

export const CameraIcon = () => <Svg><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /></Svg>;
export const MenuIcon = () => <Svg><path d="M4 7h16M4 12h16M4 17h16" /></Svg>;
export const BroadcastIcon = () => <Svg><circle cx="12" cy="12" r="2" /><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8" /></Svg>;
