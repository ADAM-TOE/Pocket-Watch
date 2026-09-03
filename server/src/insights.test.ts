import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from './app.js';
import { getDashboardSummary } from './dashboard.js';
import { initSchema } from './db.js';
import { buildCandidateFacts, type InsightModel, type InsightModelInput } from './insights.js';
import { createAuthedUser } from './test-helpers.js';
import { createUserStore } from './store.js';

function setup(model: InsightModel, insightTimeoutMs?: number) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  const { userId, cookie } = createAuthedUser(database);

  const diningId = Number(database.prepare(`
    INSERT INTO categories (name, icon, color) VALUES ('Dining', 'fork', '#ff0000')
  `).run().lastInsertRowid);
  const cardId = Number(database.prepare(`
    INSERT INTO cards (user_id, name, nickname, color) VALUES (?, 'Test Card', 'Test', '#000000')
  `).run(userId).lastInsertRowid);
  const insertTransaction = database.prepare(`
    INSERT INTO transactions (user_id, amount_cents, description, category_id, card_id, date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertTransaction.run(userId, 7_500, 'August dinner', diningId, cardId, '2026-08-10');
  insertTransaction.run(userId, 5_000, 'July dinner', diningId, cardId, '2026-07-10');

  return {
    database,
    diningId,
    cardId,
    cookie,
    userId,
    app: createApp(database, {
      today: () => '2026-08-20',
      insightModel: model,
      insightTimeoutMs,
    }),
  };
}

test('validated model wording renders server-owned figures and evidence filters', async () => {
  let received: InsightModelInput | undefined;
  const model: InsightModel = {
    async rewrite(input) {
      received = input;
      const categoryCandidate = input.candidateFacts.find(
        (candidate) => candidate.kind === 'category_delta',
      );
      assert.ok(categoryCandidate);
      return {
        insights: [{
          candidateId: categoryCandidate.id,
          evidenceFactIds: categoryCandidate.evidenceFacts.map((fact) => fact.id),
          text: categoryCandidate.allowedTemplates[1],
        }],
      };
    },
  };
  const context = setup(model);

  try {
    const response = await request(context.app).get('/api/insights?year=2026&month=8').set('Cookie', context.cookie);

    assert.equal(response.status, 200);
    assert.equal(response.body.source, 'model');
    assert.equal(response.body.insights.length, 1);
    assert.equal(
      response.body.insights[0].text,
      'Compared with the same period last month, Dining spending is higher by $25.00.',
    );
    assert.deepEqual(response.body.insights[0].evidence.filters, {
      year: 2026,
      month: 8,
      categoryId: context.diningId,
    });
    assert.deepEqual(
      response.body.insights[0].evidence.figures.map((figure: { valueCents: number }) =>
        figure.valueCents),
      [7_500, 5_000, 2_500],
    );
    assert.ok(received);
    assert.equal(JSON.stringify(received).includes('August dinner'), false);
    assert.equal(JSON.stringify(received).includes('Test Card'), false);
  } finally {
    context.database.close();
  }
});

test('unknown facts, invented numbers, and malformed output use deterministic fallback', async () => {
  const invalidOutputs: unknown[] = [
    {
      insights: [{
        candidateId: 'unknown-fact',
        evidenceFactIds: ['unknown-evidence'],
        text: '{{categoryName}} spending changed.',
      }],
    },
    {
      insights: [{
        candidateId: 'category-delta-1',
        evidenceFactIds: ['category-1-current', 'category-1-previous', 'category-1-delta'],
        text: 'Dining spending increased by $25.00.',
      }],
    },
    'not-json',
  ];

  for (const output of invalidOutputs) {
    const context = setup({ async rewrite() { return output; } });
    try {
      const response = await request(context.app).get('/api/insights?year=2026&month=8').set('Cookie', context.cookie);
      assert.equal(response.status, 200);
      assert.equal(response.body.source, 'fallback');
      assert.equal(
        response.body.insights[0].text,
        'Dining spending is $25.00 higher than the same period last month.',
      );
      assert.equal(JSON.stringify(response.body).includes('increased by $25.00'), false);
    } finally {
      context.database.close();
    }
  }
});

test('model timeout returns fallback content without failing the endpoint', async () => {
  const model: InsightModel = {
    rewrite(_input, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
  const context = setup(model, 5);

  try {
    const response = await request(context.app).get('/api/insights?year=2026&month=8').set('Cookie', context.cookie);
    assert.equal(response.status, 200);
    assert.equal(response.body.source, 'fallback');
    assert.equal(response.body.insights.length >= 1 && response.body.insights.length <= 3, true);
  } finally {
    context.database.close();
  }
});

test('arithmetic inconsistency prevents candidate generation', () => {
  const context = setup({ async rewrite() { return { insights: [] }; } });
  try {
    const summary = getDashboardSummary(
      createUserStore(context.database, context.userId),
      { year: 2026, month: 8 },
      '2026-08-20',
    );
    const inconsistent = {
      ...summary,
      totals: { ...summary.totals, deltaCents: summary.totals.deltaCents + 1 },
    };
    assert.deepEqual(buildCandidateFacts(inconsistent), []);
  } finally {
    context.database.close();
  }
});

test('validated results are cached and a transaction write invalidates the month', async () => {
  let calls = 0;
  const model: InsightModel = {
    async rewrite(input) {
      calls += 1;
      const candidate = input.candidateFacts[0];
      return {
        insights: [{
          candidateId: candidate.id,
          evidenceFactIds: candidate.evidenceFacts.map((fact) => fact.id),
          text: candidate.allowedTemplates[0],
        }],
      };
    },
  };
  const context = setup(model);

  try {
    const first = await request(context.app).get('/api/insights?year=2026&month=8').set('Cookie', context.cookie);
    const second = await request(context.app).get('/api/insights?year=2026&month=8').set('Cookie', context.cookie);
    assert.equal(first.body.source, 'model');
    assert.equal(second.body.source, 'cache');
    assert.equal(calls, 1);

    const created = await request(context.app).post('/api/transactions').set('Cookie', context.cookie).send({
      amountCents: 1_000,
      description: 'Another dinner',
      categoryId: context.diningId,
      cardId: context.cardId,
      date: '2026-08-15',
    });
    assert.equal(created.status, 201);

    const refreshed = await request(context.app).get('/api/insights?year=2026&month=8').set('Cookie', context.cookie);
    assert.equal(refreshed.body.source, 'model');
    assert.equal(calls, 2);
    assert.equal(refreshed.body.insights[0].text.includes('$35.00'), true);

    const cachedAgain = await request(context.app).get('/api/insights?year=2026&month=8').set('Cookie', context.cookie);
    assert.equal(cachedAgain.body.source, 'cache');
    const budget = await request(context.app).put('/api/budgets/2026/8').set('Cookie', context.cookie).send({
      totalBudgetCents: 200_000,
      allocations: [{ categoryId: context.diningId, amountCents: 200_000 }],
    });
    assert.equal(budget.status, 200);

    const afterBudget = await request(context.app).get('/api/insights?year=2026&month=8').set('Cookie', context.cookie);
    assert.equal(afterBudget.body.source, 'model');
    assert.equal(calls, 3);
  } finally {
    context.database.close();
  }
});