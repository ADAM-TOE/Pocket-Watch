import { Router, type Response } from 'express';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { invalidateInsightCache } from './insights.js';
import { categoryExists, createUserStore, type UserStore } from './store.js';

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

function readBudget(store: UserStore, period: Period) {
  const totalBudgetCents = store.totalBudget(period.year, period.month);
  const following = followingPeriod(period);
  const rows = store.budgetAllocationsWithSpend(
    period.year,
    period.month,
    periodStart(period.year, period.month),
    periodStart(following.year, following.month),
  );

  return {
    period,
    totalBudgetCents: totalBudgetCents ?? null,
    allocatedCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
    allocations: rows.map((row) => ({
      ...row,
      remainingCents: row.amountCents - row.spentCents,
    })),
  };
}

function assertCategoriesExist(database: Database.Database, budget: SaveBudget): boolean {
  return budget.allocations.every((allocation) => categoryExists(database, allocation.categoryId));
}

export function createBudgetsRouter(database: Database.Database): Router {
  const router = Router();

  router.get('/:year/:month', (request, response) => {
    const period = periodSchema.safeParse(request.params);
    if (!period.success) {
      sendValidationError(response, period.error);
      return;
    }

    const store = createUserStore(database, request.userId!);
    response.json(readBudget(store, period.data));
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

    const store = createUserStore(database, request.userId!);
    database.transaction((selectedPeriod: Period, input: SaveBudget) => {
      store.replaceBudgets(
        selectedPeriod.year,
        selectedPeriod.month,
        input.totalBudgetCents,
        input.allocations,
      );
      invalidateInsightCache(store, selectedPeriod);
    })(period.data, budget.data);

    response.json(readBudget(store, period.data));
  });

  return router;
}