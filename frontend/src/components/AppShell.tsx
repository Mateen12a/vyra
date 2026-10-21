import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { minutes } from "../lib/api";
import { useAuth } from "../lib/auth";
import { CameraIcon, CreditIcon, HomeIcon, PlusIcon, SettingsIcon, ShieldIcon, StudioIcon, Wordmark } from "./ui";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Signed-in frame: a sidebar on desktop, a bottom bar on phones. The balance is always one glance away.
export function AppShell() {
  const { me, catalogue, signOut } = useAuth();
  const navigate = useNavigate();
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (!me) return null;
  const perMinute = catalogue?.live_credits_per_minute || 60;
  const links = [
    { to: "/app", label: "Home", icon: <HomeIcon />, end: true },
    { to: "/app/studio", label: "Live", icon: <StudioIcon /> },
    { to: "/app/create", label: "Create", icon: <CameraIcon /> },
    { to: "/app/credits", label: "Credits", icon: <CreditIcon /> },
    { to: "/app/settings", label: "Settings", icon: <SettingsIcon /> },
    ...(me.user.role === "admin" ? [{ to: "/admin", label: "Admin", icon: <ShieldIcon /> }] : []),
  ];
  return (
    <div className="shell">
      <aside className="shell-side">
        <div className="shell-brand"><Wordmark to="/app" /></div>
        <nav className="shell-nav" aria-label="App">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className="shell-link">{l.icon}<span>{l.label}</span></NavLink>
          ))}
        </nav>
        {installPrompt && (
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-block"
            onClick={async () => {
              await installPrompt.prompt();
              setInstallPrompt(null);
            }}
          >
            Install VYRANI App
          </button>
        )}
        <button type="button" className="balance" onClick={() => navigate("/app/credits")} aria-label="Credits and purchases">
          <span className="balance-label">Balance</span>
          <span className="balance-value num">{me.balance.toLocaleString("en-US")} <small>credits</small></span>
          <span className="balance-time num">{minutes(me.balance, perMinute)} of live</span>
          <span className="balance-add"><PlusIcon /> Add credits</span>
        </button>
        <button type="button" className="btn btn-ghost btn-sm btn-block shell-signout" onClick={signOut}>Sign out</button>
      </aside>
      <header className="shell-top">
        <Wordmark to="/app" />
        <button type="button" className="balance-chip num" onClick={() => navigate("/app/credits")}>
          {me.balance.toLocaleString("en-US")} <small>credits</small><span className="balance-chip-add"><PlusIcon /></span>
        </button>
        <button type="button" className="shell-top-signout" onClick={signOut}>Sign out</button>
      </header>
      <main className="shell-main"><Outlet /></main>
      <nav className="shell-tabbar" aria-label="App">
        {links.filter((l) => l.to !== "/admin").map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className="tabbar-link">{l.icon}<span>{l.label}</span></NavLink>
        ))}
      </nav>
    </div>
  );
}
