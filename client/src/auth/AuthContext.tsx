import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { fetchMe, logout as apiLogout, type AuthUser } from '../api';

// 'loading' = we haven't asked the server yet; 'authed'/'anon' = we know.
type AuthStatus = 'loading' | 'authed' | 'anon';

type AuthContextValue = {
  user: AuthUser | null;
  status: AuthStatus;
  // Called by the login form after a successful sign-in / set-password / recover.
  setUser: (user: AuthUser) => void;
  // Re-ask the server who we are (used to detect an expired session).
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

// React Context lets any component read the auth state without passing it down
// through every intermediate component (no "prop drilling"). null is the "used
// outside the provider" sentinel that useAuth() guards against.
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const authVersion = useRef(0);

  const clearAuth = useCallback(() => {
    authVersion.current += 1;
    setUserState(null);
    setExpiresAt(null);
    setStatus('anon');
  }, []);

  const refresh = useCallback(async () => {
    const version = ++authVersion.current;
    try {
      const me = await fetchMe();
      if (version !== authVersion.current) return;
      const deadline = me ? Date.parse(me.expiresAt) : NaN;
      if (!me || !Number.isFinite(deadline) || deadline <= Date.now()) {
        clearAuth();
        return;
      }
      setUserState(me.user);
      setExpiresAt(deadline);
      setStatus('authed');
    } catch {
      // A network/server error while checking is treated as "not signed in" so
      // the app fails closed to the login screen rather than showing a shell.
      if (version === authVersion.current) clearAuth();
    }
  }, [clearAuth]);

  // Ask the server once on first load whether a session cookie is still valid.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setUser = useCallback((next: AuthUser) => {
    setUserState(next);
    setExpiresAt(null);
    setStatus('loading');
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (status !== 'authed' || expiresAt === null) return;
    const checkExpiry = () => {
      if (Date.now() >= expiresAt) clearAuth();
    };
    const timer = window.setTimeout(checkExpiry, Math.max(0, expiresAt - Date.now()));
    window.addEventListener('focus', checkExpiry);
    window.addEventListener('pageshow', checkExpiry);
    document.addEventListener('visibilitychange', checkExpiry);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', checkExpiry);
      window.removeEventListener('pageshow', checkExpiry);
      document.removeEventListener('visibilitychange', checkExpiry);
    };
  }, [status, expiresAt, clearAuth]);

  const signOut = useCallback(async () => {
    clearAuth();
    await apiLogout();
  }, [clearAuth]);

  return (
    <AuthContext.Provider value={{ user, status, setUser, refresh, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

// Small hook so components write `const { user } = useAuth()` and get a clear
// error if they forget to wrap the tree in <AuthProvider>.
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}
