import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { hashPassword, verifyPassword, validatePasswordPolicy } from './passwords.js';
import {
  createSession,
  deleteSessionByToken,
  validateSession,
  SESSION_ABSOLUTE_MS,
} from './sessions.js';
import { consumeRecoveryCode } from './recovery.js';

// Adds req.userId, set by requireAuth and read by every owner-scoped router.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

const COOKIE_NAME = 'pw_session';

// Throttling window: too many failures for one email inside this window locks
// further attempts until older failures age out.
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILURES = 5;

const loginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(1024),
  })
  .strict();

const setPasswordSchema = loginSchema;

const recoverSchema = z
  .object({
    email: z.string().trim().email().max(254),
    code: z.string().trim().min(1).max(128),
    password: z.string().min(1).max(1024),
  })
  .strict();

type UserRow = { id: number; email: string; passwordHash: string | null };

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

// Manual cookie parse (no dependency): pull our named cookie out of the header.
function readSessionCookie(request: Request): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function setSessionCookie(response: Response, token: string): void {
  response.cookie(COOKIE_NAME, token, {
    httpOnly: true, // JS in the browser cannot read it (blunts XSS token theft)
    sameSite: 'lax', // not sent on cross-site POSTs (baseline CSRF defense)
    secure: isProduction(), // HTTPS-only in production
    path: '/',
    maxAge: SESSION_ABSOLUTE_MS,
  });
}

function clearSessionCookie(response: Response): void {
  response.clearCookie(COOKIE_NAME, { path: '/' });
}

// A precomputed hash we verify against when the email is unknown, so an unknown
// email and a wrong password cost the same time — no timing side channel. Lazy +
// memoized because hashing is async and must not block module import.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(randomBytes(32).toString('hex'));
  }
  return dummyHashPromise;
}

function recentFailureCount(database: Database.Database, email: string): number {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count FROM login_attempts
       WHERE email = ? AND succeeded = 0 AND created_at >= ?`,
    )
    .get(email, since) as { count: number };
  return row.count;
}

function recordAttempt(
  database: Database.Database,
  email: string,
  ip: string,
  succeeded: boolean,
): void {
  database
    .prepare(
      `INSERT INTO login_attempts (email, ip, succeeded, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(email, ip, succeeded ? 1 : 0, new Date().toISOString());
}

// Operator-only account creation (no public signup). Used by the seed/admin
// script and by tests. Returns the new user id.
export async function createUser(
  database: Database.Database,
  email: string,
  password: string,
): Promise<number> {
  const policyError = validatePasswordPolicy(password);
  if (policyError) throw new Error(policyError);
  const passwordHash = await hashPassword(password);
  const result = database
    .prepare('INSERT INTO users (email, password_hash, must_set_pw) VALUES (?, ?, 0)')
    .run(email.trim().toLowerCase(), passwordHash);
  return Number(result.lastInsertRowid);
}

// Auth middleware: validates the session cookie, sets req.userId, or 401s. Mount
// this in front of every data router so a route cannot run without an owner.
export function requireAuth(database: Database.Database) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const token = readSessionCookie(request);
    const session = token ? validateSession(database, token) : null;
    if (!session) {
      response.status(401).json({
        error: { code: 'UNAUTHENTICATED', message: 'Not signed in.' },
      });
      return;
    }
    request.userId = session.userId;
    next();
  };
}

export function createAuthRouter(database: Database.Database): Router {
  const router = Router();

  router.post('/login', async (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Email and password are required.' },
      });
      return;
    }

    const email = parsed.data.email.toLowerCase();
    const ip = request.ip ?? '';

    if (recentFailureCount(database, email) >= MAX_FAILURES) {
      recordAttempt(database, email, ip, false);
      response.status(429).json({
        error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again later.' },
      });
      return;
    }

    const user = database
      .prepare('SELECT id, email, password_hash AS passwordHash FROM users WHERE email = ?')
      .get(email) as UserRow | undefined;

    // Always run a verify (against a dummy hash for unknown/passwordless users)
    // so response time and behavior do not reveal whether the email exists.
    const hashToCheck = user?.passwordHash ?? (await getDummyHash());
    let passwordOk = false;
    try {
      passwordOk = await verifyPassword(hashToCheck, parsed.data.password);
    } catch {
      passwordOk = false;
    }

    if (!user || !user.passwordHash || !passwordOk) {
      recordAttempt(database, email, ip, false);
      response.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
      });
      return;
    }

    recordAttempt(database, email, ip, true);
    // Rotate: a brand-new session id at login defeats session fixation.
    const token = createSession(database, user.id);
    setSessionCookie(response, token);
    response.json({ user: { id: user.id, email: user.email } });
  });

  router.post('/logout', (request, response) => {
    const token = readSessionCookie(request);
    if (token) deleteSessionByToken(database, token);
    clearSessionCookie(response);
    response.status(204).end();
  });

  // Completes the forced first-login password set for a bootstrap (must_set_pw)
  // account, then logs the user in. Only works while the account has no password.
  router.post('/set-password', async (request, response) => {
    const parsed = setPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Email and password are required.' },
      });
      return;
    }

    const email = parsed.data.email.toLowerCase();
    const user = database
      .prepare(
        'SELECT id, email, password_hash AS passwordHash, must_set_pw AS mustSetPw FROM users WHERE email = ?',
      )
      .get(email) as (UserRow & { mustSetPw: number }) | undefined;

    if (!user || user.passwordHash !== null || user.mustSetPw !== 1) {
      response.status(400).json({
        error: { code: 'SET_PASSWORD_NOT_ALLOWED', message: 'Password cannot be set for this account.' },
      });
      return;
    }

    const policyError = validatePasswordPolicy(parsed.data.password);
    if (policyError) {
      response.status(400).json({ error: { code: 'WEAK_PASSWORD', message: policyError } });
      return;
    }

    const passwordHash = await hashPassword(parsed.data.password);
    database
      .prepare('UPDATE users SET password_hash = ?, must_set_pw = 0 WHERE id = ?')
      .run(passwordHash, user.id);

    const token = createSession(database, user.id);
    setSessionCookie(response, token);
    response.json({ user: { id: user.id, email: user.email } });
  });

  // Consumes a valid one-time recovery code to reset the password. On success it
  // invalidates every existing session for that user (a reset should log an
  // attacker out everywhere) and logs the user in with a fresh session.
  router.post('/recover', async (request, response) => {
    const parsed = recoverSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Email, code, and a new password are required.' },
      });
      return;
    }

    const policyError = validatePasswordPolicy(parsed.data.password);
    if (policyError) {
      response.status(400).json({ error: { code: 'WEAK_PASSWORD', message: policyError } });
      return;
    }

    const email = parsed.data.email.toLowerCase();
    const passwordHash = await hashPassword(parsed.data.password);

    // Do the match, reset, and session purge as one unit so a code cannot be
    // spent without the password actually changing.
    const userId = database.transaction(() => {
      const matchedId = consumeRecoveryCode(database, email, parsed.data.code);
      if (matchedId === null) return null;
      database
        .prepare('UPDATE users SET password_hash = ?, must_set_pw = 0 WHERE id = ?')
        .run(passwordHash, matchedId);
      database.prepare('DELETE FROM sessions WHERE user_id = ?').run(matchedId);
      return matchedId;
    })();

    if (userId === null) {
      // One generic message for unknown email, wrong code, or already-used code.
      response.status(400).json({
        error: { code: 'INVALID_RECOVERY_CODE', message: 'Invalid or already-used recovery code.' },
      });
      return;
    }

    const token = createSession(database, userId);
    setSessionCookie(response, token);
    const user = database
      .prepare('SELECT id, email FROM users WHERE id = ?')
      .get(userId) as { id: number; email: string };
    response.json({ user });
  });

  router.get('/me', (request, response) => {
    const token = readSessionCookie(request);
    const session = token ? validateSession(database, token) : null;
    if (!session) {
      response.status(401).json({
        error: { code: 'UNAUTHENTICATED', message: 'Not signed in.' },
      });
      return;
    }
    const user = database
      .prepare('SELECT id, email FROM users WHERE id = ?')
      .get(session.userId) as { id: number; email: string } | undefined;
    if (!user) {
      response.status(401).json({
        error: { code: 'UNAUTHENTICATED', message: 'Not signed in.' },
      });
      return;
    }
    response.json({ user });
  });

  return router;
}
