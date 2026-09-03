import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from './app.js';
import { initSchema, migrateToUserOne } from './db.js';
import { createUser } from './auth.js';
import { hashToken, generateSessionToken } from './sessions.js';

const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery staple';

async function setup() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  const userId = await createUser(database, EMAIL, PASSWORD);
  return { database, app: createApp(database), userId };
}

// Pull the raw session token out of a Set-Cookie header so tests can both replay
// it and check how it is stored server-side.
function extractCookie(setCookie: string | string[] | undefined): { header: string; token: string } {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  assert.ok(cookies.length > 0, 'expected a Set-Cookie header');
  const header = cookies[0].split(';')[0];
  const token = decodeURIComponent(header.split('=').slice(1).join('='));
  return { header, token };
}

test('login sets a cookie, /me returns the user, logout invalidates it', async () => {
  const { database, app } = await setup();
  try {
    const login = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.email, EMAIL);
    const { header, token } = extractCookie(login.headers['set-cookie']);

    const me = await request(app).get('/api/auth/me').set('Cookie', header);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, EMAIL);

    // The DB stores only sha256(token), never the raw cookie value.
    const stored = database
      .prepare('SELECT token_hash AS tokenHash FROM sessions')
      .get() as { tokenHash: string };
    assert.equal(stored.tokenHash, hashToken(token));
    assert.notEqual(stored.tokenHash, token);

    const logout = await request(app).post('/api/auth/logout').set('Cookie', header);
    assert.equal(logout.status, 204);

    const afterLogout = await request(app).get('/api/auth/me').set('Cookie', header);
    assert.equal(afterLogout.status, 401);
  } finally {
    database.close();
  }
});

test('wrong password and unknown email return the same generic 401', async () => {
  const { database, app } = await setup();
  try {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: 'this is the wrong password' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'this is the wrong password' });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.deepEqual(wrongPassword.body, unknownEmail.body);
  } finally {
    database.close();
  }
});

test('stored password is an argon2id hash, never plaintext', async () => {
  const { database } = await setup();
  try {
    const row = database
      .prepare('SELECT password_hash AS passwordHash FROM users WHERE email = ?')
      .get(EMAIL) as { passwordHash: string };
    assert.ok(row.passwordHash.startsWith('$argon2id$'), 'expected an argon2id hash');
    assert.notEqual(row.passwordHash, PASSWORD);
  } finally {
    database.close();
  }
});

test('each login rotates to a fresh session id', async () => {
  const { database, app } = await setup();
  try {
    const first = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    const second = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    const tokenA = extractCookie(first.headers['set-cookie']).token;
    const tokenB = extractCookie(second.headers['set-cookie']).token;
    assert.notEqual(tokenA, tokenB);
    const sessionCount = database.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number };
    assert.equal(sessionCount.c, 2);
  } finally {
    database.close();
  }
});

test('an expired session is rejected and removed', async () => {
  const { database, app, userId } = await setup();
  try {
    const token = generateSessionToken();
    const past = new Date(Date.now() - 1000).toISOString();
    database
      .prepare(
        `INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(userId, hashToken(token), past, past, past);

    const me = await request(app).get('/api/auth/me').set('Cookie', `pw_session=${token}`);
    assert.equal(me.status, 401);
    const remaining = database.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number };
    assert.equal(remaining.c, 0);
  } finally {
    database.close();
  }
});

test('repeated failed logins are throttled', async () => {
  const { database, app } = await setup();
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: EMAIL, password: 'wrong wrong wrong' });
      assert.equal(response.status, 401);
    }
    // Sixth attempt is locked out even with the correct password.
    const locked = await request(app)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    assert.equal(locked.status, 429);
  } finally {
    database.close();
  }
});

test('createUser rejects a password shorter than the policy minimum', async () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  try {
    await assert.rejects(() => createUser(database, 'short@example.com', 'tooshort'));
  } finally {
    database.close();
  }
});

// Builds a database with the OLD pre-auth schema (no users table, no user_id
// columns) and some real data, to exercise the real upgrade path: initSchema
// must create user #1 and backfill every existing row's owner to that user.
function createLegacyDatabase(): { database: Database.Database; txCount: number; txSum: number } {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      nickname TEXT,
      color TEXT NOT NULL DEFAULT '#888888',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      icon TEXT NOT NULL DEFAULT '💸',
      color TEXT NOT NULL DEFAULT '#888888',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      description TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      card_id INTEGER NOT NULL REFERENCES cards(id),
      date TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
      category_id INTEGER REFERENCES categories(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const categoryId = Number(
    database.prepare("INSERT INTO categories (name, icon, color) VALUES ('Dining', 'x', '#fff')").run()
      .lastInsertRowid,
  );
  const cardId = Number(
    database.prepare("INSERT INTO cards (name, nickname, color) VALUES ('Card', 'C', '#000')").run()
      .lastInsertRowid,
  );
  database
    .prepare('INSERT INTO transactions (amount_cents, description, category_id, card_id, date) VALUES (?, ?, ?, ?, ?)')
    .run(1999, 'Coffee', categoryId, cardId, '2026-01-15');
  database
    .prepare('INSERT INTO transactions (amount_cents, description, category_id, card_id, date) VALUES (?, ?, ?, ?, ?)')
    .run(5000, 'Dinner', categoryId, cardId, '2026-01-20');
  database
    .prepare('INSERT INTO budgets (year, month, category_id, amount_cents) VALUES (2026, 1, NULL, 200000)')
    .run();
  const totals = database
    .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents), 0) AS s FROM transactions')
    .get() as { c: number; s: number };
  return { database, txCount: totals.c, txSum: totals.s };
}

test('migration creates user #1, backfills owners, and leaves totals unchanged', async () => {
  const { database, txCount, txSum } = createLegacyDatabase();
  try {
    initSchema(database); // runs the full upgrade: user #1 + owner-column backfill

    const users = database
      .prepare('SELECT id, email, password_hash AS passwordHash, must_set_pw AS mustSetPw FROM users')
      .all() as Array<{ id: number; email: string; passwordHash: string | null; mustSetPw: number }>;
    assert.equal(users.length, 1);
    assert.equal(users[0].passwordHash, null);
    assert.equal(users[0].mustSetPw, 1);
    const ownerId = users[0].id;

    // Every existing row is now owned by user #1.
    for (const table of ['cards', 'transactions', 'budgets']) {
      const owners = database
        .prepare(`SELECT DISTINCT user_id AS userId FROM ${table}`)
        .all() as Array<{ userId: number }>;
      assert.deepEqual(owners, [{ userId: ownerId }]);
    }

    const after = database
      .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents), 0) AS s FROM transactions')
      .get() as { c: number; s: number };
    assert.equal(after.c, txCount);
    assert.equal(after.s, txSum);

    // Idempotent: re-running the schema init does not add another user.
    initSchema(database);
    const count = database.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    assert.equal(count.c, 1);
  } finally {
    database.close();
  }
});

test('migration does nothing on an empty database', () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  try {
    migrateToUserOne(database);
    const count = database.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    assert.equal(count.c, 0);
  } finally {
    database.close();
  }
});

test('a bootstrap account cannot log in until set-password completes', async () => {
  const { database } = createLegacyDatabase();
  initSchema(database);
  const app = createApp(database);
  try {
    const email = (
      database.prepare('SELECT email FROM users').get() as { email: string }
    ).email;

    // Login is blocked while must_set_pw (no usable placeholder hash).
    const blocked = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    assert.equal(blocked.status, 401);

    // A too-short password is rejected.
    const weak = await request(app).post('/api/auth/set-password').send({ email, password: 'tooshort' });
    assert.equal(weak.status, 400);

    // Setting a valid password clears the flag, stores an argon2id hash, logs in.
    const set = await request(app).post('/api/auth/set-password').send({ email, password: PASSWORD });
    assert.equal(set.status, 200);
    const cookie = extractCookie(set.headers['set-cookie']).header;
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, email);

    const row = database
      .prepare('SELECT password_hash AS passwordHash, must_set_pw AS mustSetPw FROM users WHERE email = ?')
      .get(email) as { passwordHash: string; mustSetPw: number };
    assert.ok(row.passwordHash.startsWith('$argon2id$'));
    assert.equal(row.mustSetPw, 0);

    // Normal login now works, and set-password cannot be reused.
    const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    assert.equal(login.status, 200);
    const reuse = await request(app).post('/api/auth/set-password').send({ email, password: PASSWORD });
    assert.equal(reuse.status, 400);
  } finally {
    database.close();
  }
});
