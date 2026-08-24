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

  const diningId = Number(database.prepare(`
    INSERT INTO categories (name, icon, color) VALUES ('Dining', 'fork', '#ff0000')
  `).run().lastInsertRowid);
  const groceriesId = Number(database.prepare(`
    INSERT INTO categories (name, icon, color) VALUES ('Groceries', 'cart', '#00ff00')
  `).run().lastInsertRowid);
  const cardId = Number(database.prepare(`
    INSERT INTO cards (name, nickname, color) VALUES ('Test Card', 'Test', '#000000')
  `).run().lastInsertRowid);

  return { database, app: createApp(database), diningId, groceriesId, cardId };
}

test('exact category allocations save and return spending-derived remaining amounts', async () => {
  const context = setup();
  try {
    context.database.prepare(`
      INSERT INTO transactions (amount_cents, description, category_id, card_id, date)
      VALUES (?, ?, ?, ?, ?)
    `).run(12_500, 'Dinner', context.diningId, context.cardId, '2026-08-10');

    const saved = await request(context.app).put('/api/budgets/2026/8').send({
      totalBudgetCents: 200_000,
      allocations: [
        { categoryId: context.diningId, amountCents: 50_000 },
        { categoryId: context.groceriesId, amountCents: 150_000 },
      ],
    });

    assert.equal(saved.status, 200);
    assert.equal(saved.body.totalBudgetCents, 200_000);
    assert.equal(saved.body.allocatedCents, 200_000);
    assert.deepEqual(saved.body.allocations, [
      {
        categoryId: context.diningId,
        categoryName: 'Dining',
        amountCents: 50_000,
        spentCents: 12_500,
        remainingCents: 37_500,
      },
      {
        categoryId: context.groceriesId,
        categoryName: 'Groceries',
        amountCents: 150_000,
        spentCents: 0,
        remainingCents: 150_000,
      },
    ]);

    const read = await request(context.app).get('/api/budgets/2026/8');
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, saved.body);
  } finally {
    context.database.close();
  }
});

test('under-allocation and over-allocation are rejected without changing saved data', async () => {
  const context = setup();
  try {
    const valid = {
      totalBudgetCents: 200_000,
      allocations: [
        { categoryId: context.diningId, amountCents: 50_000 },
        { categoryId: context.groceriesId, amountCents: 150_000 },
      ],
    };
    assert.equal(
      (await request(context.app).put('/api/budgets/2026/8').send(valid)).status,
      200,
    );

    for (const amountCents of [149_999, 150_001]) {
      const response = await request(context.app).put('/api/budgets/2026/8').send({
        ...valid,
        allocations: [
          valid.allocations[0],
          { categoryId: context.groceriesId, amountCents },
        ],
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'ALLOCATION_MISMATCH');
    }

    const read = await request(context.app).get('/api/budgets/2026/8');
    assert.equal(read.body.totalBudgetCents, 200_000);
    assert.equal(read.body.allocatedCents, 200_000);
  } finally {
    context.database.close();
  }
});

test('overspending is negative and editing one month preserves another month', async () => {
  const context = setup();
  try {
    const saveMonth = (month: number, diningAmountCents: number) =>
      request(context.app).put(`/api/budgets/2026/${month}`).send({
        totalBudgetCents: 200_000,
        allocations: [
          { categoryId: context.diningId, amountCents: diningAmountCents },
          { categoryId: context.groceriesId, amountCents: 200_000 - diningAmountCents },
        ],
      });

    assert.equal((await saveMonth(7, 40_000)).status, 200);
    assert.equal((await saveMonth(8, 50_000)).status, 200);
    context.database.prepare(`
      INSERT INTO transactions (amount_cents, description, category_id, card_id, date)
      VALUES (?, ?, ?, ?, ?)
    `).run(55_000, 'August dining', context.diningId, context.cardId, '2026-08-12');
    assert.equal((await saveMonth(8, 60_000)).status, 200);

    const july = await request(context.app).get('/api/budgets/2026/7');
    const august = await request(context.app).get('/api/budgets/2026/8');
    assert.equal(july.body.allocations[0].amountCents, 40_000);
    assert.equal(august.body.allocations[0].amountCents, 60_000);

    assert.equal((await saveMonth(8, 50_000)).status, 200);
    const overspent = await request(context.app).get('/api/budgets/2026/8');
    assert.equal(overspent.body.allocations[0].remainingCents, -5_000);
  } finally {
    context.database.close();
  }
});

test('invalid periods, duplicate categories, and missing categories are rejected', async () => {
  const context = setup();
  try {
    const invalidPeriod = await request(context.app).get('/api/budgets/2026/13');
    assert.equal(invalidPeriod.status, 400);

    const duplicate = await request(context.app).put('/api/budgets/2026/8').send({
      totalBudgetCents: 200_000,
      allocations: [
        { categoryId: context.diningId, amountCents: 100_000 },
        { categoryId: context.diningId, amountCents: 100_000 },
      ],
    });
    assert.equal(duplicate.status, 400);

    const missingCategory = await request(context.app).put('/api/budgets/2026/8').send({
      totalBudgetCents: 200_000,
      allocations: [{ categoryId: 9999, amountCents: 200_000 }],
    });
    assert.equal(missingCategory.status, 400);
    assert.equal(missingCategory.body.error.code, 'INVALID_CATEGORY');
  } finally {
    context.database.close();
  }
});