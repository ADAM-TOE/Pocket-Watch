import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { requireAuth, setSessionCookie } from './auth.js';
import { createSession } from './sessions.js';

// ---------- Relying-Party (RP) configuration ----------
// In WebAuthn the "relying party" is our site. The RP ID is the site's domain
// (no scheme/port); the origin is the exact page URL the browser reports. Both
// are checked during verification so a signature minted for another site is
// rejected. Defaults target local dev (Vite on :5173); production overrides via
// env for the deployed HTTPS domain.
const RP_ID = process.env.WEBAUTHN_RP_ID?.trim() || 'localhost';
const RP_NAME = process.env.WEBAUTHN_RP_NAME?.trim() || 'Pocket Watch';
// A comma-separated list lets us accept more than one dev origin if needed.
const EXPECTED_ORIGINS = (process.env.WEBAUTHN_ORIGIN?.trim() || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const CHALLENGE_COOKIE = 'pw_webauthn';
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes to finish a ceremony

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

// ---------- Clone detection (exported so it can be unit-tested) ----------
// WebAuthn authenticators may keep a signature counter that increments on every
// use. Per the spec, if either the stored or the new counter is non-zero and the
// new one did not increase, that is a signal the authenticator was cloned — two
// copies would step on each other's count. Many platform passkeys always report
// 0 (they sync across devices instead), and 0-vs-0 is explicitly allowed.
export function counterRegressed(storedCount: number, newCount: number): boolean {
  if (storedCount === 0 && newCount === 0) return false;
  return newCount <= storedCount;
}

// ---------- Challenge store (single-use, cookie-bound) ----------
type ChallengeRow = { challenge: string; purpose: string; userId: number | null; expiresAt: string };

function setChallengeCookie(response: Response, id: string): void {
  response.cookie(CHALLENGE_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    maxAge: CHALLENGE_TTL_MS,
  });
}

function clearChallengeCookie(response: Response): void {
  response.clearCookie(CHALLENGE_COOKIE, { path: '/' });
}

function readChallengeCookie(request: Request): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CHALLENGE_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// Persist a challenge and return the random id that names it (also the cookie
// value). Old expired rows are swept opportunistically to keep the table small.
function storeChallenge(
  database: Database.Database,
  challenge: string,
  purpose: 'register' | 'login',
  userId: number | null,
): string {
  database.prepare("DELETE FROM webauthn_challenges WHERE expires_at < datetime('now')").run();
  const id = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  database
    .prepare(
      `INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, challenge, purpose, userId, expiresAt);
  return id;
}

// Fetch a challenge by cookie id and DELETE it in the same step so it can be used
// exactly once (replay defense). Returns null if missing, wrong purpose, or expired.
function consumeChallenge(
  database: Database.Database,
  request: Request,
  purpose: 'register' | 'login',
): ChallengeRow | null {
  const id = readChallengeCookie(request);
  if (!id) return null;
  const row = database
    .prepare(
      `SELECT challenge, purpose, user_id AS userId, expires_at AS expiresAt
       FROM webauthn_challenges WHERE id = ?`,
    )
    .get(id) as ChallengeRow | undefined;
  // Single-use: remove it whether or not it turns out to be valid.
  database.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(id);
  if (!row) return null;
  if (row.purpose !== purpose) return null;
  if (Date.now() >= new Date(row.expiresAt).getTime()) return null;
  return row;
}

type CredentialRow = {
  id: number;
  userId: number;
  credentialId: string;
  publicKey: Buffer;
  signCount: number;
  transports: string | null;
};

function credentialsForUser(database: Database.Database, userId: number): CredentialRow[] {
  return database
    .prepare(
      `SELECT id, user_id AS userId, credential_id AS credentialId,
              public_key AS publicKey, sign_count AS signCount, transports
       FROM webauthn_credentials WHERE user_id = ?`,
    )
    .all(userId) as CredentialRow[];
}

export function createWebAuthnRouter(database: Database.Database): Router {
  const router = Router();

  // --- Enrollment: create a passkey for the ALREADY LOGGED-IN user. ---
  router.post('/register/options', requireAuth(database), async (request, response) => {
    const userId = request.userId as number;
    const user = database
      .prepare('SELECT email FROM users WHERE id = ?')
      .get(userId) as { email: string } | undefined;
    if (!user) {
      response.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not signed in.' } });
      return;
    }

    const existing = credentialsForUser(database, userId);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: user.email,
      // The user handle links a passkey to this account. We encode our numeric id.
      userID: new TextEncoder().encode(String(userId)),
      // Stop the same device enrolling twice.
      excludeCredentials: existing.map((cred) => ({
        id: cred.credentialId,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });

    const id = storeChallenge(database, options.challenge, 'register', userId);
    setChallengeCookie(response, id);
    response.json(options);
  });

  router.post('/register/verify', requireAuth(database), async (request, response) => {
    const userId = request.userId as number;
    const challenge = consumeChallenge(database, request, 'register');
    clearChallengeCookie(response);
    // The challenge must belong to the same user that started enrollment.
    if (!challenge || challenge.userId !== userId) {
      response.status(400).json({
        error: { code: 'CHALLENGE_INVALID', message: 'Your enrollment attempt expired. Try again.' },
      });
      return;
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: request.body as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: EXPECTED_ORIGINS,
        expectedRPID: RP_ID,
      });
    } catch {
      verification = { verified: false } as const;
    }

    if (!verification.verified || !verification.registrationInfo) {
      response.status(400).json({
        error: { code: 'REGISTRATION_FAILED', message: 'Could not verify the passkey.' },
      });
      return;
    }

    const { credential } = verification.registrationInfo;
    const transports = (request.body as RegistrationResponseJSON).response?.transports;
    try {
      database
        .prepare(
          `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, sign_count, transports)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          credential.id,
          Buffer.from(credential.publicKey),
          credential.counter,
          transports ? JSON.stringify(transports) : null,
        );
    } catch {
      // UNIQUE(credential_id) violation = this passkey is already enrolled.
      response.status(409).json({
        error: { code: 'ALREADY_REGISTERED', message: 'That passkey is already registered.' },
      });
      return;
    }

    response.json({ verified: true });
  });

  // --- Passkey login: no session yet, so these routes are public. ---
  router.post('/login/options', async (_request, response) => {
    // No allowCredentials: this is "usernameless" login — the browser lets the
    // user pick a resident passkey (Face ID / Windows Hello), no email typed.
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred',
    });
    const id = storeChallenge(database, options.challenge, 'login', null);
    setChallengeCookie(response, id);
    response.json(options);
  });

  router.post('/login/verify', async (request, response) => {
    const challenge = consumeChallenge(database, request, 'login');
    clearChallengeCookie(response);
    if (!challenge) {
      response.status(400).json({
        error: { code: 'CHALLENGE_INVALID', message: 'Your sign-in attempt expired. Try again.' },
      });
      return;
    }

    const body = request.body as AuthenticationResponseJSON;
    const cred = database
      .prepare(
        `SELECT id, user_id AS userId, credential_id AS credentialId,
                public_key AS publicKey, sign_count AS signCount, transports
         FROM webauthn_credentials WHERE credential_id = ?`,
      )
      .get(body?.id) as CredentialRow | undefined;
    if (!cred) {
      response.status(401).json({
        error: { code: 'UNKNOWN_CREDENTIAL', message: 'Unrecognized passkey.' },
      });
      return;
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: challenge.challenge,
        expectedOrigin: EXPECTED_ORIGINS,
        expectedRPID: RP_ID,
        credential: {
          id: cred.credentialId,
          publicKey: new Uint8Array(cred.publicKey),
          counter: cred.signCount,
        },
      });
    } catch {
      verification = { verified: false } as const;
    }

    const newCounter =
      'authenticationInfo' in verification ? verification.authenticationInfo.newCounter : 0;
    // Defense in depth: the library rejects a regressed counter, and we re-check
    // it ourselves so the clone rule is explicit and independently tested.
    if (!verification.verified || counterRegressed(cred.signCount, newCounter)) {
      response.status(401).json({
        error: { code: 'AUTH_FAILED', message: 'Passkey sign-in failed.' },
      });
      return;
    }

    database
      .prepare('UPDATE webauthn_credentials SET sign_count = ? WHERE id = ?')
      .run(newCounter, cred.id);

    const token = createSession(database, cred.userId);
    setSessionCookie(response, token);
    const user = database
      .prepare('SELECT id, email FROM users WHERE id = ?')
      .get(cred.userId) as { id: number; email: string };
    response.json({ user });
  });

  return router;
}
