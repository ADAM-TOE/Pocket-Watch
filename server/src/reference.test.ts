import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from './app.js';
import { initSchema } from './db.js';
import { createAuthedUser } from './test-helpers.js';

function freshApp() {
  const database = new Database(':memory:');
  initSchema(database);
  const { userId, cookie } = createAuthedUser(database);
  return { app: createApp(database), database, cookie, userId };
}

test('GET /api/reference returns cards and categories with stable shape', async () => {
  const { app, database, cookie, userId } = freshApp();
  database.prepare('INSERT INTO cards (user_id, name, nickname, color) VALUES (?, ?, ?, ?)')
    .run(userId, 'Chase Freedom Unlimited', 'Freedom', '#1f6fb2');
  database.prepare('INSERT INTO categories (name, icon, color) VALUES (?, ?, ?)')
    .run('Groceries', '🛒', '#4caf50');
  database.prepare('INSERT INTO categories (name, icon, color) VALUES (?, ?, ?)')
    .run('Dining', '🍽️', '#ff7043');

  const response = await request(app).get('/api/reference').set('Cookie', cookie);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.cards, [
    { id: 1, name: 'Chase Freedom Unlimited', nickname: 'Freedom', color: '#1f6fb2' },
  ]);
  // Categories are ordered by name, so Dining precedes Groceries.
  assert.deepEqual(response.body.categories.map((category: { name: string }) => category.name), [
    'Dining',
    'Groceries',
  ]);
});
test('GET /api/reference returns empty arrays when no data is seeded', async () => {
  const { app, cookie } = freshApp();

  const response = await request(app).get('/api/reference').set('Cookie', cookie);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { cards: [], categories: [] });
});

test('POST /api/reference/cards creates a card and returns it', async () => {
  const { app, cookie } = freshApp();

  const response = await request(app)
    .post('/api/reference/cards')
    .set('Cookie', cookie)
    .send({ name: 'Amex Gold', nickname: 'Gold', color: '#d4af37' });

  assert.equal(response.status, 201);
  assert.deepEqual(response.body.card, {
    id: 1,
    name: 'Amex Gold',
    nickname: 'Gold',
    color: '#d4af37',
  });

  const listed = await request(app).get('/api/reference').set('Cookie', cookie);
  assert.equal(listed.body.cards.length, 1);
  assert.equal(listed.body.cards[0].name, 'Amex Gold');
});

test('POST /api/reference/cards defaults color and allows no nickname', async () => {
  const { app, cookie } = freshApp();

  const response = await request(app)
    .post('/api/reference/cards')
    .set('Cookie', cookie)
    .send({ name: 'Discover It' });

  assert.equal(response.status, 201);
  assert.equal(response.body.card.nickname, null);
  assert.equal(response.body.card.color, '#888888');
});

test('POST /api/reference/cards rejects a missing name', async () => {
  const { app, cookie } = freshApp();

  const response = await request(app).post('/api/reference/cards').set('Cookie', cookie).send({ nickname: 'x' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
});
test('POST /api/reference/cards rejects a malformed color', async () => {
  const { app, cookie } = freshApp();

  const response = await request(app)
    .post('/api/reference/cards')
    .set('Cookie', cookie)
    .send({ name: 'Bad Color', color: 'blue' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
});

