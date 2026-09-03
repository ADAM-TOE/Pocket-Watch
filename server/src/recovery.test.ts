import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from './app.js';
import { initSchema } from './db.js';
import { seedReferenceData } from './seed.js';
import { createAccount } from './accounts.js';
import { hashRecoveryCode, RECOVERY_CODE_COUNT } from './recovery.js';

const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new long passphrase';

async function setup() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  seedReferenceData(database);
  const { userId, recoveryCodes } = await createAccount(database, EMAIL, PASSWORD);
  return { database, app: createApp(database), userId, recoveryCodes };
}

test('createAccount seeds cards + a budget and stores hashed recovery codes', async () => {
  const { database, userId, recoveryCodes } = await setup();
  try {
    assert.equal(recoveryCodes.length, RECOVERY_CODE_COUNT);

    const cardCount = database
      .prepare('SELECT COUNT(*) AS c FROM cards WHERE user_id = ?')
      .get(userId) as { c: number };
    assert.equal(cardCount.c, 4);

    const budget = database
      .prepare('SELECT amount_cents AS cents FROM budgets WHERE user_id = ? AND category_id IS NULL')
      .get(userId) as { cents: number } | undefined;
    assert.ok(budget, 'expected a seeded total budget');
    assert.equal(budget.cents, 200_000);

    // Codes are stored ONLY as sha256 hashes — never the plaintext we return once.
    const stored = database
      .prepare('SELECT code_hash AS codeHash FROM recovery_codes WHERE user_id = ?')
      .all(userId) as Array<{ codeHash: string }>;
    assert.equal(stored.length, RECOVERY_CODE_COUNT);
    const storedHashes = new Set(stored.map((row) => row.codeHash));
    for (const code of recoveryCodes) {
      assert.ok(!storedHashes.has(code), 'plaintext code must not be stored');
      assert.ok(storedHashes.has(hashRecoveryCode(code)), 'expected the hashed code to be stored');
    }
  } finally {
    database.close();
  }
});

test('a valid recovery code resets the password, logs in, and is then unusable', async () => {
  const { database, app, recoveryCodes } = await setup();
  try {
    const code = recoveryCodes[0];

    const recover = await request(app)
      .post('/api/auth/recover')
      .send({ email: EMAIL, code, password: NEW_PASSWORD });
    assert.equal(recover.status, 200);
    assert.equal(recover.body.user.email, EMAIL);
    assert.ok(recover.headers['set-cookie'], 'recover should log the user in');

    // Old password no longer works; the new one does.
    const oldLogin = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    assert.equal(oldLogin.status, 401);
    const newLogin = await request(app).post('/api/auth/login').send({ email: EMAIL, password: NEW_PASSWORD });
    assert.equal(newLogin.status, 200);

    // The same code cannot be spent twice.
    const reuse = await request(app)
      .post('/api/auth/recover')
      .send({ email: EMAIL, code, password: 'yet another long passphrase' });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error.code, 'INVALID_RECOVERY_CODE');
  } finally {
    database.close();
  }
});

test('an unknown code and an unknown email both fail generically', async () => {
  const { database, app } = await setup();
  try {
    const badCode = await request(app)
      .post('/api/auth/recover')
      .send({ email: EMAIL, code: 'ffff-ffff-ffff-ffff', password: NEW_PASSWORD });
    assert.equal(badCode.status, 400);
    assert.equal(badCode.body.error.code, 'INVALID_RECOVERY_CODE');

    const unknownEmail = await request(app)
      .post('/api/auth/recover')
      .send({ email: 'nobody@example.com', code: 'ffff-ffff-ffff-ffff', password: NEW_PASSWORD });
    assert.equal(unknownEmail.status, 400);
    assert.deepEqual(unknownEmail.body, badCode.body);
  } finally {
    database.close();
  }
});

test('recover rejects a new password that fails the length policy', async () => {
  const { database, app, recoveryCodes } = await setup();
  try {
    const response = await request(app)
      .post('/api/auth/recover')
      .send({ email: EMAIL, code: recoveryCodes[0], password: 'tooshort' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WEAK_PASSWORD');

    // A rejected reset must NOT consume the code.
    const stillUnused = database
      .prepare('SELECT used_at AS usedAt FROM recovery_codes WHERE user_id = 1 AND used_at IS NULL')
      .all() as Array<{ usedAt: string | null }>;
    assert.equal(stillUnused.length, RECOVERY_CODE_COUNT);
  } finally {
    database.close();
  }
});

test('recovering the password invalidates existing sessions', async () => {
  const { database, app, recoveryCodes } = await setup();
  try {
    // Establish a live session with the old password.
    const login = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    assert.equal(login.status, 200);
    const oldCookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

    const before = await request(app).get('/api/auth/me').set('Cookie', oldCookie);
    assert.equal(before.status, 200);

    await request(app)
      .post('/api/auth/recover')
      .send({ email: EMAIL, code: recoveryCodes[1], password: NEW_PASSWORD });

    // The pre-reset session cookie is now dead.
    const after = await request(app).get('/api/auth/me').set('Cookie', oldCookie);
    assert.equal(after.status, 401);
  } finally {
    database.close();
  }
});
