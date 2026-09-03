import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from './app.js';
import { initSchema } from './db.js';
import { createAuthedUser } from './test-helpers.js';

function setup(today = '2026-08-20') {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  const { userId, cookie } = createAuthedUser(database);

  const diningId = Number(database.prepare(`
    INSERT INTO categories (name, icon, color) VALUES ('Dining', 'fork', '#ff0000')
  `).run().lastInsertRowid);
  const groceriesId = Number(database.prepare(`
    INSERT INTO categories (name, icon, color) VALUES ('Groceries', 'cart', '#00ff00')
  `).run().lastInsertRowid);
  const cardId = Number(database.prepare(`
    INSERT INTO cards (user_id, name, nickname, color) VALUES (?, 'Test Card', 'Test', '#000000')
  `).run(userId).lastInsertRowid);

  const insertTransaction = database.prepare(`
    INSERT INTO transactions (user_id, amount_cents, description, category_id, card_id, date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const addTransaction = (
    amountCents: number,
    description: string,
    categoryId: number,
    date: string,
  ) => insertTransaction.run(userId, amountCents, description, categoryId, cardId, date);

  return {
    database,
    app: createApp(database, { today: () => today }),
    diningId,
    groceriesId,
    addTransaction,
    cookie,
    userId,
  };
}

test('dashboard returns exact month-to-date totals, fair comparison, categories, and trend', async () => {
  const context = setup();
  try {
    context.database.prepare(`
      INSERT INTO budgets (user_id, year, month, category_id, amount_cents)
      VALUES (?, 2026, 8, NULL, 200000)
    `).run(context.userId);
    context.database.prepare(`
      INSERT INTO budgets (user_id, year, month, category_id, amount_cents)
      VALUES (?, 2026, 8, ?, 50000)
    `).run(context.userId, context.diningId);
    context.addTransaction(2000, 'Lunch', context.diningId, '2026-08-01');
    context.addTransaction(3000, 'Market', context.groceriesId, '2026-08-20');
    context.addTransaction(9000, 'Future purchase', context.diningId, '2026-08-21');
    context.addTransaction(1500, 'July lunch', context.diningId, '2026-07-01');
    context.addTransaction(1000, 'July market', context.groceriesId, '2026-07-20');
    context.addTransaction(8000, 'Late July', context.diningId, '2026-07-21');

    const response = await request(context.app).get('/api/dashboard?year=2026&month=8').set('Cookie', context.cookie);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.period, {
      year: 2026,
      month: 8,
      throughDay: 20,
      comparison: { year: 2026, month: 7, throughDay: 20 },
    });
    assert.deepEqual(response.body.totals, {
      spentCents: 5000,
      budgetCents: 200000,
      remainingCents: 195000,
      currentComparisonSpentCents: 5000,
      previousSpentCents: 2500,
      deltaCents: 2500,
    });
    assert.deepEqual(
      response.body.recentTransactions.map((transaction: { description: string }) => transaction.description),
      ['Market', 'Lunch'],
    );
    assert.deepEqual(
      response.body.categories.map((category: {
        name: string;
        spentCents: number;
        previousSpentCents: number;
        deltaCents: number;
        shareBasisPoints: number;
        budgetCents: number | null;
        remainingCents: number | null;
      }) => ({
        name: category.name,
        spentCents: category.spentCents,
        previousSpentCents: category.previousSpentCents,
        deltaCents: category.deltaCents,
        shareBasisPoints: category.shareBasisPoints,
        budgetCents: category.budgetCents,
        remainingCents: category.remainingCents,
      })),
      [
        {
          name: 'Groceries',
          spentCents: 3000,
          previousSpentCents: 1000,
          deltaCents: 2000,
          shareBasisPoints: 6000,
          budgetCents: null,
          remainingCents: null,
        },
        {
          name: 'Dining',
          spentCents: 2000,
          previousSpentCents: 1500,
          deltaCents: 500,
          shareBasisPoints: 4000,
          budgetCents: 50000,
          remainingCents: 48000,
        },
      ],
    );
    assert.equal(response.body.trend.length, 20);
    assert.deepEqual(response.body.trend[0], {
      day: 1,
      currentCumulativeCents: 2000,
      previousCumulativeCents: 1500,
    });
    assert.deepEqual(response.body.trend[19], {
      day: 20,
      currentCumulativeCents: 5000,
      previousCumulativeCents: 2500,
    });
  } finally {
    context.database.close();
  }
});

test('dashboard handles zero spending and a missing budget without invented values', async () => {
  const context = setup();
  try {
    const response = await request(context.app).get('/api/dashboard?year=2026&month=8').set('Cookie', context.cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.totals, {
      spentCents: 0,
      budgetCents: null,
      remainingCents: null,
      currentComparisonSpentCents: 0,
      previousSpentCents: 0,
      deltaCents: 0,
    });
    assert.deepEqual(response.body.categories, []);
    assert.equal(response.body.trend.length, 20);
    assert.equal(response.body.trend.every((point: {
      currentCumulativeCents: number;
      previousCumulativeCents: number;
    }) => point.currentCumulativeCents === 0 && point.previousCumulativeCents === 0), true);
  } finally {
    context.database.close();
  }
});

test('dashboard reports overspending as a negative remaining amount', async () => {
  const context = setup();
  try {
    context.database.prepare(`
      INSERT INTO budgets (user_id, year, month, category_id, amount_cents)
      VALUES (?, 2026, 8, NULL, 4000)
    `).run(context.userId);
    context.addTransaction(5000, 'Large market trip', context.groceriesId, '2026-08-10');

    const response = await request(context.app).get('/api/dashboard?year=2026&month=8').set('Cookie', context.cookie);
    assert.equal(response.status, 200);
    assert.equal(response.body.totals.spentCents, 5000);
    assert.equal(response.body.totals.remainingCents, -1000);
  } finally {
    context.database.close();
  }
});

test('historical February comparison handles leap years, January rollover, and unequal month lengths', async () => {
  const context = setup('2026-08-20');
  try {
    context.addTransaction(2900, 'Leap day', context.diningId, '2024-02-29');
    context.addTransaction(2800, 'January day 28', context.diningId, '2024-01-28');
    context.addTransaction(3000, 'January day 30', context.diningId, '2024-01-30');

    const february = await request(context.app).get('/api/dashboard?year=2024&month=2').set('Cookie', context.cookie);
    assert.equal(february.status, 200);
    assert.deepEqual(february.body.period, {
      year: 2024,
      month: 2,
      throughDay: 29,
      comparison: { year: 2024, month: 1, throughDay: 29 },
    });
    assert.equal(february.body.totals.spentCents, 2900);
    assert.equal(february.body.totals.previousSpentCents, 2800);

    context.addTransaction(3100, 'January end', context.diningId, '2026-01-31');
    context.addTransaction(3000, 'December end', context.diningId, '2025-12-31');
    const january = await request(context.app).get('/api/dashboard?year=2026&month=1').set('Cookie', context.cookie);
    assert.deepEqual(january.body.period.comparison, { year: 2025, month: 12, throughDay: 31 });
    assert.equal(january.body.totals.deltaCents, 100);
  } finally {
    context.database.close();
  }
});

test('dashboard rejects invalid periods', async () => {
  const context = setup();
  try {
    const response = await request(context.app).get('/api/dashboard?year=2026&month=13').set('Cookie', context.cookie);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  } finally {
    context.database.close();
  }
});