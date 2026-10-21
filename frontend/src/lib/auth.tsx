import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, type Catalogue, type Me } from "./api";

type AuthState = {
  me: Me | null;
  loading: boolean;
  catalogue: Catalogue | null;
  refresh: () => Promise<Me | null>;
  setBalance: (balance: number) => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api<Me>("/api/auth/me");
      setMe(next);
      return next;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 404)) setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Prices are only served to signed-in users.
  const signedIn = Boolean(me);
  useEffect(() => {
    if (signedIn) api<Catalogue>("/api/pricing").then(setCatalogue).catch(() => {});
    else setCatalogue(null);
  }, [signedIn]);

  const setBalance = useCallback((balance: number) => {
    setMe(current => current && current.balance !== balance ? { ...current, balance } : current);
  }, []);
  // Ends the session on the server, then reloads the landing page so no signed-in state survives in memory.
  const signOut = useCallback(async () => {
    await api("/api/auth/logout", {}).catch(() => {});
    setCatalogue(null);
    window.location.assign("/");
  }, []);

  const value = useMemo<AuthState>(() => ({
    me, loading, catalogue, refresh, setBalance, signOut,
  }), [me, loading, catalogue, refresh, setBalance, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
