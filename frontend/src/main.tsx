import { Component, StrictMode, lazy, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import "./styles/global.css";
import "./styles/app.css";
import { AppShell } from "./components/AppShell";
import { Spinner, ToastProvider } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { Landing } from "./pages/Landing";
import { Forgot, Reset, SignIn, SignUp, Verify } from "./pages/Auth";
import { Dashboard } from "./pages/Dashboard";
import { CreditsPage } from "./pages/Credits";
import { Settings } from "./pages/Settings";

// The studio and admin are heavier; load them when opened.
const Studio = lazy(() => import("./studio/Studio"));
const Admin = lazy(() => import("./pages/Admin"));
const Create = lazy(() => import("./pages/Create"));
const Privacy = lazy(() => import("./pages/Legal").then((m) => ({ default: m.Privacy })));
const Terms = lazy(() => import("./pages/Legal").then((m) => ({ default: m.Terms })));

function Loading() {
  return <div className="page-loading"><Spinner /></div>;
}

class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="page-loading" role="alert">
          <div>
            <h1>VYRANI couldn't load this page</h1>
            <p>Reload to try again. If this keeps happening, share the error from your browser console.</p>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload page</button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

function RequireAuth({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (admin && me.user.role !== "admin") return <Navigate to="/app" replace />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <Loading />;
  return me ? <Navigate to="/app" replace /> : <>{children}</>;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PageErrorBoundary>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/signin" element={<GuestOnly><SignIn /></GuestOnly>} />
              <Route path="/signup" element={<GuestOnly><SignUp /></GuestOnly>} />
              <Route path="/forgot" element={<Forgot />} />
              <Route path="/reset" element={<Reset />} />
              <Route path="/verify" element={<Verify />} />
              <Route path="/app" element={<RequireAuth><AppShell /></RequireAuth>}>
                <Route index element={<Dashboard />} />
                <Route path="studio" element={<Studio />} />
                <Route path="create" element={<Create />} />
                <Route path="credits" element={<CreditsPage />} />
                <Route path="settings" element={<Settings />} />
              </Route>
              <Route path="/admin" element={<RequireAuth admin><AppShell /></RequireAuth>}>
                <Route index element={<Admin />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
    </PageErrorBoundary>
  </StrictMode>,
);
