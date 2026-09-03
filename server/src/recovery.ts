import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';

// How many one-time codes a new account gets. Enough that losing a few to
// everyday use still leaves spares before the user must regenerate.
export const RECOVERY_CODE_COUNT = 8;

// Each code carries 80 bits of entropy (10 random bytes → 20 hex chars). That is
// astronomically large, so guessing one is infeasible even without rate limits.
const RECOVERY_CODE_BYTES = 10;

// Strip formatting so the way a code is displayed (dashes, letter case) never
// changes what we match on. The user can type "ABCD-EF01" or "abcdef01".
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

// A recovery code is HIGH-entropy random data, so a fast one-way hash (sha256)
// is the correct tool — the same choice we make for session tokens. Argon2 is
// deliberately slow to protect LOW-entropy human passwords from guessing; that
// cost buys nothing for an 80-bit random string and would only slow logins.
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

// Produce display codes like "a1b2-c3d4-e5f6-7890" (four groups for readability).
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const raw = randomBytes(RECOVERY_CODE_BYTES).toString('hex');
    const grouped = raw.match(/.{1,4}/g)!.join('-');
    codes.push(grouped);
  }
  return codes;
}

// Persist the HASHED codes for a user. Plaintext is returned to the caller once
// (to show the operator/user) and never written to the database.
export function storeRecoveryCodes(
  database: Database.Database,
  userId: number,
  codes: string[],
): void {
  const insert = database.prepare(
    'INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)',
  );
  for (const code of codes) insert.run(userId, hashRecoveryCode(code));
}

// Atomically match and consume one unused recovery code for an email. Returns the
// owning user id on success (and marks that code used), or null if the email is
// unknown or no unused code matches. The UPDATE ... WHERE used_at IS NULL guard
// makes double-spend impossible even under concurrent requests: only the first
// caller sees changes === 1.
export function consumeRecoveryCode(
  database: Database.Database,
  email: string,
  code: string,
): number | null {
  const user = database
    .prepare('SELECT id FROM users WHERE email = ?')
    .get(email.trim().toLowerCase()) as { id: number } | undefined;
  if (!user) return null;

  const targetHash = Buffer.from(hashRecoveryCode(code), 'hex');
  const rows = database
    .prepare('SELECT id, code_hash AS codeHash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
    .all(user.id) as Array<{ id: number; codeHash: string }>;

  // Constant-time compare against every candidate so timing never reveals how
  // close a guess was. We scan all rows (no early break) for the same reason.
  let matchId: number | null = null;
  for (const row of rows) {
    const rowHash = Buffer.from(row.codeHash, 'hex');
    if (rowHash.length === targetHash.length && timingSafeEqual(rowHash, targetHash)) {
      matchId = row.id;
    }
  }
  if (matchId === null) return null;

  const result = database
    .prepare("UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL")
    .run(matchId);
  if (result.changes !== 1) return null;
  return user.id;
}
