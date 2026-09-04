import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from './app.js';
import { initSchema } from './db.js';
import { createAuthedUser } from './test-helpers.js';
import { counterRegressed } from './webauthn.js';

function setup() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  return { database, app: createApp(database) };
}

// Pull the challenge cookie out of a Set-Cookie header so a follow-up request
// can present it (mirrors how the browser would).
function challengeCookie(setCookie: string | string[] | undefined): string | null {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = cookies.find((cookie) => cookie.startsWith('pw_webauthn='));
  return match ? match.split(';')[0] : null;
}

// ---------- counterRegressed: the clone-detection rule ----------
test('counterRegressed follows the WebAuthn spec', () => {
  // 0/0 is normal for synced platform passkeys — not a clone.
  assert.equal(counterRegressed(0, 0), false);
  // Normal forward progress.
  assert.equal(counterRegressed(5, 6), false);
  assert.equal(counterRegressed(0, 1), false);
  // A counter that stays the same or goes backwards while non-zero = clone signal.
  assert.equal(counterRegressed(6, 6), true);
  assert.equal(counterRegressed(6, 5), true);
  assert.equal(counterRegressed(1, 0), true);
});

// ---------- Enrollment requires an authenticated session ----------
test('register/options rejects an unauthenticated caller', async () => {
  const { app } = setup();
  const res = await request(app).post('/api/auth/webauthn/register/options').send({});
  assert.equal(res.status, 401);
});

test('register/options returns a challenge and sets a cookie for a logged-in user', async () => {
  const { database, app } = setup();
  const { cookie } = createAuthedUser(database, 'owner@example.com');
  const res = await request(app)
    .post('/api/auth/webauthn/register/options')
    .set('Cookie', cookie)
    .send({});
  assert.equal(res.status, 200);
  assert.ok(res.body.challenge, 'options include a challenge');
  assert.ok(challengeCookie(res.headers['set-cookie']), 'a pw_webauthn cookie is set');
  // The challenge is now persisted server-side, ready to be matched on verify.
  const stored = database.prepare('SELECT COUNT(*) AS c FROM webauthn_challenges').get() as { c: number };
  assert.equal(stored.c, 1);
});

// ---------- Login options are public ----------
test('login/options works without a session and issues a challenge', async () => {
  const { app } = setup();
  const res = await request(app).post('/api/auth/webauthn/login/options').send({});
  assert.equal(res.status, 200);
  assert.ok(res.body.challenge);
  assert.ok(challengeCookie(res.headers['set-cookie']));
});

// ---------- Unknown credential is rejected on login ----------
test('login/verify rejects an unrecognized passkey', async () => {
  const { app } = setup();
  const options = await request(app).post('/api/auth/webauthn/login/options').send({});
  const cookie = challengeCookie(options.headers['set-cookie']);
  assert.ok(cookie);

  const res = await request(app)
    .post('/api/auth/webauthn/login/verify')
    .set('Cookie', cookie)
    .send({ id: 'this-credential-does-not-exist', response: {} });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'UNKNOWN_CREDENTIAL');
});

// ---------- Challenges are single-use ----------
test('a challenge cannot be replayed after it is consumed', async () => {
  const { database, app } = setup();
  const options = await request(app).post('/api/auth/webauthn/login/options').send({});
  const cookie = challengeCookie(options.headers['set-cookie']);
  assert.ok(cookie);
  assert.equal(
    (database.prepare('SELECT COUNT(*) AS c FROM webauthn_challenges').get() as { c: number }).c,
    1,
  );

  // First verify consumes (deletes) the challenge, even though it fails on the
  // unknown credential.
  await request(app)
    .post('/api/auth/webauthn/login/verify')
    .set('Cookie', cookie)
    .send({ id: 'nope', response: {} });
  assert.equal(
    (database.prepare('SELECT COUNT(*) AS c FROM webauthn_challenges').get() as { c: number }).c,
    0,
    'challenge row is deleted after one use',
  );

  // Re-presenting the same cookie now finds no challenge → generic expiry error.
  const replay = await request(app)
    .post('/api/auth/webauthn/login/verify')
    .set('Cookie', cookie)
    .send({ id: 'nope', response: {} });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error.code, 'CHALLENGE_INVALID');
});
