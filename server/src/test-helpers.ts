import type Database from 'better-sqlite3';
import { generateSessionToken, hashToken } from './sessions.js';

// Test-only helper: creates a user and a live session directly (no argon2, no
// HTTP round-trip) so router tests can authenticate synchronously. Returns the
// owner id and a ready-to-send Cookie header value. Auth itself is exercised
// separately in auth.test.ts.
export function createAuthedUser(
  database: Database.Database,
  email = 'tester@example.com',
): { userId: number; cookie: string } {
  const userId = Number(
    database
      .prepare("INSERT INTO users (email, password_hash, must_set_pw) VALUES (?, 'x', 0)")
      .run(email).lastInsertRowid,
  );
  const token = generateSessionToken();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  database
    .prepare(
      `INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(userId, hashToken(token), now, now, expires);
  return { userId, cookie: `pw_session=${token}` };
}
