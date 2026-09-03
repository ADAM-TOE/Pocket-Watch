import { hash, verify, Algorithm } from '@node-rs/argon2';

// Length beats complexity rules: a long passphrase is stronger and easier to
// remember than a short "P@ss1" style string. Enforce a floor, not a ruleset.
export const PASSWORD_MIN_LENGTH = 12;

// Returns a human-readable reason if the password fails policy, otherwise null.
export function validatePasswordPolicy(plain: unknown): string | null {
  if (typeof plain !== 'string' || plain.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  return null;
}

// Argon2id is a memory-hard hash: verifying one password costs real RAM + time,
// so a stolen database is expensive to crack even with fast GPUs. The cost
// parameters live here in one place so they can be raised later.
export function hashPassword(plain: string): Promise<string> {
  return hash(plain, { algorithm: Algorithm.Argon2id });
}

// Argon2 encodes its parameters and salt inside the hash string, so verify only
// needs the stored hash + the candidate password. Returns false on any mismatch.
export function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  return verify(storedHash, plain);
}
