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
    api<Catalogue>("/api/pricing").then(setCatalogue).catch(() => {});
  }, [refresh]);

  const setBalance = useCallback((balance: number) => {
    setMe(current => current && current.balance !== balance ? { ...current, balance } : current);
  }, []);
  const signOut = useCallback(async () => {
    await api("/api/auth/logout", {}).catch(() => {});
    // In single-user mode /api/auth/me keeps answering; re-check instead of forcing null.
    const next = await api<Me>("/api/auth/me").catch(() => null);
    setMe(next);
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
