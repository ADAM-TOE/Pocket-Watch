import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from './app.js';
import { initSchema } from './db.js';
import { createAuthedUser } from './test-helpers.js';

// Two users, each with their own card + transaction, plus a budget for user A.
function setup() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  initSchema(database);

  const a = createAuthedUser(database, 'a@example.com');
  const b = createAuthedUser(database, 'b@example.com');

  const categoryId = Number(
    database.prepare("INSERT INTO categories (name, icon, color) VALUES ('Dining', 'x', '#fff')").run()
      .lastInsertRowid,
  );

  const insertCard = database.prepare(
    'INSERT INTO cards (user_id, name, nickname, color) VALUES (?, ?, ?, ?)',
  );
  const cardA = Number(insertCard.run(a.userId, 'A card', null, '#111').lastInsertRowid);
  const cardB = Number(insertCard.run(b.userId, 'B card', null, '#222').lastInsertRowid);

  const insertTx = database.prepare(
    'INSERT INTO transactions (user_id, amount_cents, description, category_id, card_id, date) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const txA = Number(insertTx.run(a.userId, 1000, 'A coffee', categoryId, cardA, '2026-08-05').lastInsertRowid);
  const txB = Number(insertTx.run(b.userId, 7777, 'B dinner', categoryId, cardB, '2026-08-06').lastInsertRowid);

  database
    .prepare('INSERT INTO budgets (user_id, year, month, category_id, amount_cents) VALUES (?, 2026, 8, NULL, ?)')
    .run(a.userId, 200_000);

  return {
    database,
    app: createApp(database, { today: () => '2026-08-20' }),
    a,
    b,
    categoryId,
    cardA,
    txA,
    cardB,
    txB,
  };
}

test('each user only ever sees their own cards, transactions, and dashboard totals', async () => {
  const context = setup();
  try {
    const listA = await request(context.app).get('/api/transactions').set('Cookie', context.a.cookie);
    const listB = await request(context.app).get('/api/transactions').set('Cookie', context.b.cookie);
    assert.deepEqual(
      listA.body.transactions.map((t: { description: string }) => t.description),
      ['A coffee'],
    );
    assert.deepEqual(
      listB.body.transactions.map((t: { description: string }) => t.description),
      ['B dinner'],
    );

    const refA = await request(context.app).get('/api/reference').set('Cookie', context.a.cookie);
    const refB = await request(context.app).get('/api/reference').set('Cookie', context.b.cookie);
    assert.deepEqual(refA.body.cards.map((c: { name: string }) => c.name), ['A card']);
    assert.deepEqual(refB.body.cards.map((c: { name: string }) => c.name), ['B card']);

    const dashA = await request(context.app)
      .get('/api/dashboard?year=2026&month=8')
      .set('Cookie', context.a.cookie);
    const dashB = await request(context.app)
      .get('/api/dashboard?year=2026&month=8')
      .set('Cookie', context.b.cookie);
    assert.equal(dashA.body.totals.spentCents, 1000);
    assert.equal(dashB.body.totals.spentCents, 7777);
  } finally {
    context.database.close();
  }
});

test('a user cannot read, edit, or delete another user\'s rows by id (IDOR)', async () => {
  const context = setup();
  try {
    // B edits A's transaction by id → 404, A's row untouched.
    const patch = await request(context.app)
      .patch(`/api/transactions/${context.txA}`)
      .set('Cookie', context.b.cookie)
      .send({ amountCents: 9999 });
    assert.equal(patch.status, 404);

    // B deletes A's transaction by id → 404, A's row still present.
    const del = await request(context.app)
      .delete(`/api/transactions/${context.txA}`)
      .set('Cookie', context.b.cookie);
    assert.equal(del.status, 404);

    // B tries to spend on A's card → rejected as an unknown card (scoped lookup).
    const crossCard = await request(context.app)
      .post('/api/transactions')
      .set('Cookie', context.b.cookie)
      .send({
        amountCents: 500,
        description: 'sneaky',
        categoryId: context.categoryId,
        cardId: context.cardA,
        date: '2026-08-07',
      });
    assert.equal(crossCard.status, 400);
    assert.equal(crossCard.body.error.code, 'INVALID_CARD');

    // A's transaction is unchanged and A can still edit it.
    const still = context.database
      .prepare('SELECT amount_cents AS amountCents FROM transactions WHERE id = ?')
      .get(context.txA) as { amountCents: number };
    assert.equal(still.amountCents, 1000);
    const ownEdit = await request(context.app)
      .patch(`/api/transactions/${context.txA}`)
      .set('Cookie', context.a.cookie)
      .send({ amountCents: 1200 });
    assert.equal(ownEdit.status, 200);
    assert.equal(ownEdit.body.transaction.amountCents, 1200);
  } finally {
    context.database.close();
  }
});

test('every data route requires a session', async () => {
  const context = setup();
  try {
    const unauthenticated = [
      request(context.app).get('/api/reference'),
      request(context.app).get('/api/transactions'),
      request(context.app).post('/api/transactions').send({
        amountCents: 100,
        description: 'x',
        categoryId: context.categoryId,
        cardId: context.cardA,
        date: '2026-08-07',
      }),
      request(context.app).get('/api/dashboard?year=2026&month=8'),
      request(context.app).get('/api/budgets/2026/8'),
      request(context.app).get('/api/insights?year=2026&month=8'),
    ];
    for (const pending of unauthenticated) {
      const response = await pending;
      assert.equal(response.status, 401);
    }
  } finally {
    context.database.close();
  }
});
