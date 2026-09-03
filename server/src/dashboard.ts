import { Router, type Response } from 'express';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { createUserStore, type UserStore } from './store.js';

const summaryQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
}).strict();

export type Period = { year: number; month: number };

type SummaryTransaction = {
  id: number;
  amountCents: number;
  description: string;
  categoryId: number;
  categoryName: string;
  categoryColor: string;
  cardId: number;
  cardName: string;
  date: string;
};

type CategorySummary = {
  categoryId: number;
  name: string;
  color: string;
  spentCents: number;
  comparisonSpentCents: number;
  previousSpentCents: number;
  deltaCents: number;
  shareBasisPoints: number;
  budgetCents: number | null;
  remainingCents: number | null;
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

function previousMonth(year: number, month: number): Period {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function comparePeriods(left: Period, right: Period): number {
  return left.year * 12 + left.month - (right.year * 12 + right.month);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateString(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateAfter(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return dateString(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function parseDate(value: string): { year: number; month: number; day: number } {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

export function getHouseholdDate(): string {
  const timeZone = process.env.HOUSEHOLD_TIME_ZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function throughDayForPeriod(period: Period, todayValue: string): number {
  const today = parseDate(todayValue);
  const relation = comparePeriods(period, { year: today.year, month: today.month });
  if (relation < 0) return daysInMonth(period.year, period.month);
  if (relation > 0) return 0;
  return Math.min(today.day, daysInMonth(period.year, period.month));
}

function readTransactions(
  store: UserStore,
  period: Period,
  throughDay: number,
): SummaryTransaction[] {
  if (throughDay === 0) return [];

  return store.readTransactionsBetween(
    dateString(period.year, period.month, 1),
    dateAfter(period.year, period.month, throughDay),
  );
}

function sumTransactions(transactions: SummaryTransaction[]): number {
  return transactions.reduce((total, transaction) => total + transaction.amountCents, 0);
}

function transactionsThroughDay(
  transactions: SummaryTransaction[],
  throughDay: number,
): SummaryTransaction[] {
  return transactions.filter((transaction) => Number(transaction.date.slice(8, 10)) <= throughDay);
}

function categorySummaries(
  current: SummaryTransaction[],
  currentComparison: SummaryTransaction[],
  previous: SummaryTransaction[],
  totalSpentCents: number,
  categoryBudgets: ReadonlyMap<number, number>,
): CategorySummary[] {
  const summaries = new Map<number, CategorySummary>();

  for (const transaction of current) {
    const existing = summaries.get(transaction.categoryId) ?? {
      categoryId: transaction.categoryId,
      name: transaction.categoryName,
      color: transaction.categoryColor,
      spentCents: 0,
      comparisonSpentCents: 0,
      previousSpentCents: 0,
      deltaCents: 0,
      shareBasisPoints: 0,
      budgetCents: null,
      remainingCents: null,
    };
    existing.spentCents += transaction.amountCents;
    summaries.set(transaction.categoryId, existing);
  }

  for (const transaction of currentComparison) {
    const existing = summaries.get(transaction.categoryId);
    if (existing) existing.comparisonSpentCents += transaction.amountCents;
  }

  for (const transaction of previous) {
    const existing = summaries.get(transaction.categoryId);
    if (existing) existing.previousSpentCents += transaction.amountCents;
  }

  return [...summaries.values()]
    .map((summary) => {
      const budgetCents = categoryBudgets.has(summary.categoryId)
        ? categoryBudgets.get(summary.categoryId) ?? null
        : null;
      return {
        ...summary,
        deltaCents: summary.comparisonSpentCents - summary.previousSpentCents,
        shareBasisPoints: totalSpentCents === 0
          ? 0
          : Math.round((summary.spentCents * 10_000) / totalSpentCents),
        budgetCents,
        remainingCents: budgetCents === null ? null : budgetCents - summary.spentCents,
      };
    })
    .sort((left, right) => right.spentCents - left.spentCents || left.name.localeCompare(right.name));
}

function cumulativeTrend(
  current: SummaryTransaction[],
  previous: SummaryTransaction[],
  throughDay: number,
) {
  let currentCumulativeCents = 0;
  let previousCumulativeCents = 0;

  return Array.from({ length: throughDay }, (_, index) => {
    const day = index + 1;
    currentCumulativeCents += sumTransactions(
      current.filter((transaction) => Number(transaction.date.slice(8, 10)) === day),
    );
    previousCumulativeCents += sumTransactions(
      previous.filter((transaction) => Number(transaction.date.slice(8, 10)) === day),
    );
    return { day, currentCumulativeCents, previousCumulativeCents };
  });
}

export function createDashboardRouter(
  database: Database.Database,
  today: () => string = getHouseholdDate,
): Router {
  const router = Router();

  router.get('/', (request, response) => {
    const parsed = summaryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }

    const store = createUserStore(database, request.userId!);
    response.json(getDashboardSummary(store, parsed.data, today()));
  });

  return router;
}

export function getDashboardSummary(
  store: UserStore,
  period: Period,
  todayValue: string = getHouseholdDate(),
) {
  const comparisonPeriod = previousMonth(period.year, period.month);
  const throughDay = throughDayForPeriod(period, todayValue);
  const comparisonThroughDay = Math.min(
    throughDay,
    daysInMonth(comparisonPeriod.year, comparisonPeriod.month),
  );
  const current = readTransactions(store, period, throughDay);
  const currentComparison = transactionsThroughDay(current, comparisonThroughDay);
  const previous = readTransactions(store, comparisonPeriod, comparisonThroughDay);
  const spentCents = sumTransactions(current);
  const currentComparisonSpentCents = sumTransactions(currentComparison);
  const previousSpentCents = sumTransactions(previous);
  const totalBudgetCents = store.totalBudget(period.year, period.month);
  const categoryBudgets = new Map(
    store
      .categoryBudgets(period.year, period.month)
      .map((row) => [row.categoryId, row.amountCents]),
  );

  return {
    period: {
      ...period,
      throughDay,
      comparison: { ...comparisonPeriod, throughDay: comparisonThroughDay },
    },
    totals: {
      spentCents,
      budgetCents: totalBudgetCents ?? null,
      remainingCents: totalBudgetCents !== undefined ? totalBudgetCents - spentCents : null,
      currentComparisonSpentCents,
      previousSpentCents,
      deltaCents: currentComparisonSpentCents - previousSpentCents,
    },
    recentTransactions: current.slice(0, 5),
    categories: categorySummaries(
      current,
      currentComparison,
      previous,
      spentCents,
      categoryBudgets,
    ),
    trend: cumulativeTrend(currentComparison, previous, comparisonThroughDay),
  };
}