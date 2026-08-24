import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from './app.js';
import { initSchema } from './db.js';

function setup() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  const categoryId = Number(database.prepare(`
    INSERT INTO categories (name, icon, color) VALUES ('Dining', 'fork', '#ffffff')
  `).run().lastInsertRowid);
  const cardId = Number(database.prepare(`
    INSERT INTO cards (name, nickname, color) VALUES ('Test Card', 'Test', '#000000')
  `).run().lastInsertRowid);

  return { database, app: createApp(database), categoryId, cardId };
}

test('transaction amount and date round-trip exactly through CRUD routes', async () => {
  const context = setup();
  try {
    const created = await request(context.app).post('/api/transactions').send({
      amountCents: 1999,
      description: 'Corner Cafe',
      categoryId: context.categoryId,
      cardId: context.cardId,
      date: '2026-01-31',
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.transaction.amountCents, 1999);
    assert.equal(created.body.transaction.date, '2026-01-31');

    const listed = await request(context.app).get('/api/transactions?year=2026&month=1');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.transactions.length, 1);
    assert.equal(listed.body.transactions[0].amountCents, 1999);

    const updated = await request(context.app)
      .patch(`/api/transactions/${created.body.transaction.id}`)
      .send({ amountCents: 2050, date: '2026-02-01' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.transaction.amountCents, 2050);
    assert.equal(updated.body.transaction.date, '2026-02-01');

    const deleted = await request(context.app)
      .delete(`/api/transactions/${created.body.transaction.id}`);
    assert.equal(deleted.status, 204);
    assert.equal(
      (context.database.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count,
      0,
    );
  } finally {
    context.database.close();
  }
});

test('invalid input and missing references return 400 without writing data', async () => {
  const context = setup();
  const valid = {
    amountCents: 1999,
    description: 'Corner Cafe',
    categoryId: context.categoryId,
    cardId: context.cardId,
    date: '2026-02-20',
  };

  try {
    const invalidRequests = [
      { ...valid, amountCents: 19.99 },
      { ...valid, amountCents: 0 },
      { ...valid, date: '2026-02-30' },
      { ...valid, description: '   ' },
      { ...valid, categoryId: 9999 },
      { ...valid, cardId: 9999 },
    ];

    for (const body of invalidRequests) {
      const response = await request(context.app).post('/api/transactions').send(body);
      assert.equal(response.status, 400);
    }

    assert.equal(
      (context.database.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count,
      0,
    );
  } finally {
    context.database.close();
  }
});

test('month filtering uses local calendar boundaries and stable newest-first ordering', async () => {
  const context = setup();
  try {
    const dates = ['2025-12-31', '2026-01-01', '2026-01-31', '2026-02-01'];
    for (const [index, date] of dates.entries()) {
      const response = await request(context.app).post('/api/transactions').send({
        amountCents: 1000 + index,
        description: `Purchase ${index}`,
        categoryId: context.categoryId,
        cardId: context.cardId,
        date,
      });
      assert.equal(response.status, 201);
    }

    const january = await request(context.app).get('/api/transactions?year=2026&month=1');
    assert.equal(january.status, 200);
    assert.deepEqual(
      january.body.transactions.map((transaction: { date: string }) => transaction.date),
      ['2026-01-31', '2026-01-01'],
    );
  } finally {
    context.database.close();
  }
});

test('legacy dollar columns migrate once to exact integer cents', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE cards (id INTEGER PRIMARY KEY, name TEXT, nickname TEXT, color TEXT, created_at TEXT);
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE, icon TEXT, color TEXT, created_at TEXT);
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY,
      amount REAL NOT NULL,
      description TEXT,
      category_id INTEGER,
      card_id INTEGER,
      date TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE budgets (
      id INTEGER PRIMARY KEY,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      category_id INTEGER,
      amount REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO cards VALUES (1, 'Test Card', 'Test', '#000000', '2026-01-01');
    INSERT INTO categories VALUES (1, 'Dining', 'fork', '#ffffff', '2026-01-01');
    INSERT INTO transactions VALUES (1, 19.99, 'Cafe', 1, 1, '2026-01-31', 'manual', '2026-01-31');
    INSERT INTO budgets VALUES (1, 2026, 1, NULL, 2000, '2026-01-01');
  `);

  try {
    initSchema(database);
    initSchema(database);

    const transaction = database.prepare('SELECT amount_cents AS amountCents FROM transactions').get() as {
      amountCents: number;
    };
    const budget = database.prepare('SELECT amount_cents AS amountCents FROM budgets').get() as {
      amountCents: number;
    };
    const transactionColumns = database.prepare('PRAGMA table_info(transactions)').all() as Array<{
      name: string;
    }>;

    assert.equal(transaction.amountCents, 1999);
    assert.equal(budget.amountCents, 200_000);
    assert.equal(transactionColumns.some((column) => column.name === 'amount'), false);
  } finally {
    database.close();
  }
});