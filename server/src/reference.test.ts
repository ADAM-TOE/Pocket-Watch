import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from './app.js';
import { initSchema } from './db.js';

function freshApp() {
  const database = new Database(':memory:');
  initSchema(database);
  return { app: createApp(database), database };
}

test('GET /api/reference returns cards and categories with stable shape', async () => {
  const { app, database } = freshApp();
  database.prepare('INSERT INTO cards (name, nickname, color) VALUES (?, ?, ?)')
    .run('Chase Freedom Unlimited', 'Freedom', '#1f6fb2');
  database.prepare('INSERT INTO categories (name, icon, color) VALUES (?, ?, ?)')
    .run('Groceries', '🛒', '#4caf50');
  database.prepare('INSERT INTO categories (name, icon, color) VALUES (?, ?, ?)')
    .run('Dining', '🍽️', '#ff7043');

  const response = await request(app).get('/api/reference');

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
  const { app } = freshApp();

  const response = await request(app).get('/api/reference');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { cards: [], categories: [] });
});
