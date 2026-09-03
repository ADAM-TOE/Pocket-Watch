import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      setUserState(me);
      setStatus(me ? 'authed' : 'anon');
    } catch {
      // A network/server error while checking is treated as "not signed in" so
      // the app fails closed to the login screen rather than showing a shell.
      setUserState(null);
      setStatus('anon');
    }
  }, []);

  // Ask the server once on first load whether a session cookie is still valid.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setUser = useCallback((next: AuthUser) => {
    setUserState(next);
    setStatus('authed');
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      // Clear locally even if the network call failed — the cookie is one-sided
      // useless without the server row, and the user asked to leave.
      setUserState(null);
      setStatus('anon');
    }
  }, []);

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
