import type Database from 'better-sqlite3';
import { hashPassword, validatePasswordPolicy } from './passwords.js';
import { seedUserData } from './seed.js';
import { generateRecoveryCodes, storeRecoveryCodes } from './recovery.js';

export type CreatedAccount = { userId: number; recoveryCodes: string[] };

// Operator-only account provisioning (there is NO public signup — see the
// multi-user plan §1/§7). Creates the user, seeds their starting data (four
// cards + a $2000 monthly budget), and generates one-time recovery codes — all
// as one unit of work.
//
// Two-phase shape on purpose: argon2 hashing is asynchronous and must run OUTSIDE
// the database transaction, because better-sqlite3 transactions are strictly
// synchronous (no awaiting inside). So we hash first, then do every write inside
// a single transaction so a failure never leaves a half-provisioned account.
export async function createAccount(
  database: Database.Database,
  email: string,
  password: string,
): Promise<CreatedAccount> {
  const policyError = validatePasswordPolicy(password);
  if (policyError) throw new Error(policyError);

  const passwordHash = await hashPassword(password);
  const recoveryCodes = generateRecoveryCodes();
  const normalizedEmail = email.trim().toLowerCase();

  const userId = database.transaction(() => {
    const inserted = database
      .prepare('INSERT INTO users (email, password_hash, must_set_pw) VALUES (?, ?, 0)')
      .run(normalizedEmail, passwordHash);
    const id = Number(inserted.lastInsertRowid);
    seedUserData(database, id);
    storeRecoveryCodes(database, id, recoveryCodes);
    return id;
  })();

  return { userId, recoveryCodes };
}
