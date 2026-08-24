import { Router, type Response } from 'express';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { invalidateInsightCache } from './insights.js';

const periodSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
}).strict();

const allocationSchema = z.object({
  categoryId: z.number().int().positive(),
  amountCents: z.number().int().min(0).max(100_000_000),
}).strict();

const saveBudgetSchema = z.object({
  totalBudgetCents: z.number().int().min(0).max(100_000_000),
  allocations: z.array(allocationSchema),
}).strict().refine(
  (value) => new Set(value.allocations.map((allocation) => allocation.categoryId)).size
    === value.allocations.length,
  { message: 'Each category can have only one allocation', path: ['allocations'] },
);

type Period = z.infer<typeof periodSchema>;
type SaveBudget = z.infer<typeof saveBudgetSchema>;

type BudgetRow = {
  categoryId: number;
  categoryName: string;
  amountCents: number;
  spentCents: number;
};

function sendValidationError(response: Response, error: z.ZodError): void {
  response.status(400).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'The request contains invalid fields.',
      fields: error.issues.map((issue) => ({
        field: issue.path.join('.') || 'request',
        message: issue.message,
      })),
    },
  });
}

function periodStart(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function followingPeriod({ year, month }: Period): Period {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function readBudget(database: Database.Database, period: Period) {
  const total = database.prepare(`
    SELECT amount_cents AS amountCents
    FROM budgets
    WHERE year = ? AND month = ? AND category_id IS NULL
  `).get(period.year, period.month) as { amountCents: number } | undefined;
  const following = followingPeriod(period);
  const rows = database.prepare(`
    SELECT
      budgets.category_id AS categoryId,
      categories.name AS categoryName,
      budgets.amount_cents AS amountCents,
      COALESCE(SUM(transactions.amount_cents), 0) AS spentCents
    FROM budgets
    JOIN categories ON categories.id = budgets.category_id
    LEFT JOIN transactions
      ON transactions.category_id = budgets.category_id
      AND transactions.date >= ?
      AND transactions.date < ?
    WHERE budgets.year = ? AND budgets.month = ? AND budgets.category_id IS NOT NULL
    GROUP BY budgets.category_id, categories.name, budgets.amount_cents
    ORDER BY categories.name, budgets.category_id
  `).all(
    periodStart(period.year, period.month),
    periodStart(following.year, following.month),
    period.year,
    period.month,
  ) as BudgetRow[];

  return {
    period,
    totalBudgetCents: total?.amountCents ?? null,
    allocatedCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
    allocations: rows.map((row) => ({
      ...row,
      remainingCents: row.amountCents - row.spentCents,
    })),
  };
}

function assertCategoriesExist(database: Database.Database, budget: SaveBudget): boolean {
  return budget.allocations.every((allocation) => database.prepare(
    'SELECT 1 FROM categories WHERE id = ?',
  ).get(allocation.categoryId));
}

export function createBudgetsRouter(database: Database.Database): Router {
  const router = Router();

  router.get('/:year/:month', (request, response) => {
    const period = periodSchema.safeParse(request.params);
    if (!period.success) {
      sendValidationError(response, period.error);
      return;
    }

    response.json(readBudget(database, period.data));
  });

  router.put('/:year/:month', (request, response) => {
    const period = periodSchema.safeParse(request.params);
    const budget = saveBudgetSchema.safeParse(request.body);
    if (!period.success) {
      sendValidationError(response, period.error);
      return;
    }
    if (!budget.success) {
      sendValidationError(response, budget.error);
      return;
    }

    const allocatedCents = budget.data.allocations.reduce(
      (sum, allocation) => sum + allocation.amountCents,
      0,
    );
    if (allocatedCents !== budget.data.totalBudgetCents) {
      response.status(400).json({
        error: {
          code: 'ALLOCATION_MISMATCH',
          message: 'Category allocations must equal the monthly budget.',
        },
      });
      return;
    }
    if (!assertCategoriesExist(database, budget.data)) {
      response.status(400).json({
        error: { code: 'INVALID_CATEGORY', message: 'A selected category does not exist.' },
      });
      return;
    }

    database.transaction((selectedPeriod: Period, input: SaveBudget) => {
      database.prepare('DELETE FROM budgets WHERE year = ? AND month = ?')
        .run(selectedPeriod.year, selectedPeriod.month);
      database.prepare(`
        INSERT INTO budgets (year, month, category_id, amount_cents)
        VALUES (?, ?, NULL, ?)
      `).run(selectedPeriod.year, selectedPeriod.month, input.totalBudgetCents);
      const insertAllocation = database.prepare(`
        INSERT INTO budgets (year, month, category_id, amount_cents)
        VALUES (?, ?, ?, ?)
      `);
      for (const allocation of input.allocations) {
        insertAllocation.run(
          selectedPeriod.year,
          selectedPeriod.month,
          allocation.categoryId,
          allocation.amountCents,
        );
      }
      invalidateInsightCache(database, selectedPeriod);
    })(period.data, budget.data);

    response.json(readBudget(database, period.data));
  });

  return router;
}