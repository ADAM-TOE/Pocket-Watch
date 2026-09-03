import { randomBytes, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

// Two independent clocks guard a session:
//  - IDLE: log out after a stretch of no activity (renews on each request).
//  - ABSOLUTE: a hard cap from login, even if the user stays active forever.
export const SESSION_IDLE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days idle
export const SESSION_ABSOLUTE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days absolute

// The cookie value is a 256-bit random string from a CSPRNG (crypto.randomBytes,
// never Math.random). base64url keeps it cookie-safe (no '+', '/', or '=').
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

// We store sha256(token), not the token. A read-only DB leak then yields only
// hashes, which cannot be replayed as live cookies (same reasoning as passwords).
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type SessionRow = {
  id: number;
  userId: number;
  lastSeenAt: string;
  expiresAt: string;
};

// Creates a fresh session and returns the RAW token (goes to the cookie once).
// Only the hash is persisted.
export function createSession(database: Database.Database, userId: number): string {
  const token = generateSessionToken();
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      hashToken(token),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      new Date(now + SESSION_ABSOLUTE_MS).toISOString(),
    );
  return token;
}

// Validates a raw token against both clocks. Expired/idle sessions are deleted
// and treated as absent. On success, last_seen_at is refreshed (idle renewal).
export function validateSession(
  database: Database.Database,
  token: string,
): { userId: number } | null {
  const row = database
    .prepare(
      `SELECT id, user_id AS userId, last_seen_at AS lastSeenAt, expires_at AS expiresAt
       FROM sessions WHERE token_hash = ?`,
    )
    .get(hashToken(token)) as SessionRow | undefined;
  if (!row) return null;

  const now = Date.now();
  const absoluteExpired = now >= new Date(row.expiresAt).getTime();
  const idleExpired = now - new Date(row.lastSeenAt).getTime() >= SESSION_IDLE_MS;
  if (absoluteExpired || idleExpired) {
    database.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }

  database
    .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
    .run(new Date(now).toISOString(), row.id);
  return { userId: row.userId };
}

export function deleteSessionByToken(database: Database.Database, token: string): void {
  database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}
