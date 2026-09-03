import { useState, type FormEvent } from 'react';
import { login, recover, setPassword, type AuthUser } from '../api';
import { useAuth } from '../auth/AuthContext';

// One screen, three jobs. `mode` is a tiny state machine: the same form shows
// different fields and calls a different endpoint depending on which mode is on.
type Mode = 'signin' | 'set' | 'recover';

const HEADINGS: Record<Mode, string> = {
  signin: 'Sign in',
  set: 'Set your password',
  recover: 'Reset your password',
};

const SUBTEXT: Record<Mode, string> = {
  signin: 'Enter your email and password to open your ledger.',
  set: 'First time here? Choose a password for your account.',
  recover: 'Use one of your one-time recovery codes to set a new password.',
};

const SUBMIT_LABEL: Record<Mode, string> = {
  signin: 'Sign in',
  set: 'Set password & continue',
  recover: 'Reset password & continue',
};

export function AuthScreen() {
  const { setUser } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPasswordValue] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Switching modes clears any stale error/code so the form starts clean.
  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setCode('');
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      let user: AuthUser;
      if (mode === 'signin') user = await login(email.trim(), password);
      else if (mode === 'set') user = await setPassword(email.trim(), password);
      else user = await recover(email.trim(), code.trim(), password);
      // On success the provider flips to 'authed', which unmounts this screen —
      // so there is nothing more to reset here.
      setUser(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={handleSubmit}>
        <div className="auth-brand">
          <span className="brand-mark">$</span>
          <div>
            <h1>Pocket Watch</h1>
            <span className="brand-kicker">Monthly spending ledger</span>
          </div>
        </div>

        <h2 className="auth-heading">{HEADINGS[mode]}</h2>
        <p className="auth-sub">{SUBTEXT[mode]}</p>

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>

        {mode === 'recover' && (
          <label className="field">
            <span>Recovery code</span>
            <input
              type="text"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
          </label>
        )}

        <label className="field">
          <span>{mode === 'signin' ? 'Password' : 'New password'}</span>
          <input
            type="password"
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(event) => setPasswordValue(event.target.value)}
            required
          />
        </label>

        {error && (
          <p className="sheet-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? 'Working…' : SUBMIT_LABEL[mode]}
        </button>

        <div className="auth-links">
          {mode !== 'signin' && (
            <button type="button" className="link-button" onClick={() => switchMode('signin')}>
              ← Back to sign in
            </button>
          )}
          {mode === 'signin' && (
            <>
              <button type="button" className="link-button" onClick={() => switchMode('set')}>
                First login? Set password
              </button>
              <button type="button" className="link-button" onClick={() => switchMode('recover')}>
                Use a recovery code
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
