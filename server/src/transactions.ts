import { Router, type Response } from 'express';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { invalidateInsightCacheForDates } from './insights.js';
import { categoryExists, createUserStore, type UserStore } from './store.js';

const amountCents = z.number().int().positive().max(100_000_000);
const referenceId = z.number().int().positive();

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}, 'Date must be a real calendar date in YYYY-MM-DD format');

const createTransactionSchema = z.object({
  amountCents,
  description: z.string().trim().min(1).max(200),
  categoryId: referenceId,
  cardId: referenceId,
  date: calendarDate,
}).strict();

const updateTransactionSchema = createTransactionSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'At least one transaction field is required',
);

const idSchema = z.coerce.number().int().positive();

const listSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict().refine(
  (value) => (value.year === undefined) === (value.month === undefined),
  'Year and month must be supplied together',
);

type TransactionInput = z.infer<typeof createTransactionSchema>;
type TransactionUpdate = z.infer<typeof updateTransactionSchema>;

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

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

// Category is a shared/global lookup; the card must be owned by this user.
function assertReferencesExist(
  database: Database.Database,
  store: UserStore,
  categoryId: number,
  cardId: number,
): void {
  if (!categoryExists(database, categoryId)) {
    throw new RequestError(400, 'INVALID_CATEGORY', 'The selected category does not exist.');
  }
  if (!store.cardExists(cardId)) {
    throw new RequestError(400, 'INVALID_CARD', 'The selected card does not exist.');
  }
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function periodStart(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function handleRouteError(response: Response, error: unknown): void {
  if (error instanceof RequestError) {
    response.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }

  throw error;
}

export function createTransactionsRouter(database: Database.Database): Router {
  const router = Router();

  router.get('/', (request, response) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }

    const { year, month, limit, offset } = parsed.data;
    const store = createUserStore(database, request.userId!);
    const range =
      year !== undefined && month !== undefined
        ? {
            start: periodStart(year, month),
            end: periodStart(nextMonth(year, month).year, nextMonth(year, month).month),
          }
        : null;

    const transactions = store.listTransactions(range, limit, offset);
    response.json({ transactions, pagination: { limit, offset } });
  });

  router.post('/', (request, response) => {
    const parsed = createTransactionSchema.safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }

    const store = createUserStore(database, request.userId!);
    try {
      const id = database.transaction((input: TransactionInput) => {
        assertReferencesExist(database, store, input.categoryId, input.cardId);
        const newId = store.insertTransaction(input);
        invalidateInsightCacheForDates(store, [input.date]);
        return newId;
      })(parsed.data);

      response.status(201).json({ transaction: store.getTransaction(id) });
    } catch (error) {
      handleRouteError(response, error);
    }
  });

  router.patch('/:id', (request, response) => {
    const id = idSchema.safeParse(request.params.id);
    const update = updateTransactionSchema.safeParse(request.body);
    if (!id.success) {
      sendValidationError(response, id.error);
      return;
    }
    if (!update.success) {
      sendValidationError(response, update.error);
      return;
    }

    const store = createUserStore(database, request.userId!);
    try {
      database.transaction((transactionId: number, input: TransactionUpdate) => {
        const existing = store.getTransaction(transactionId);
        if (!existing) {
          throw new RequestError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found.');
        }

        assertReferencesExist(
          database,
          store,
          input.categoryId ?? existing.categoryId,
          input.cardId ?? existing.cardId,
        );

        const columns: string[] = [];
        const values: Array<string | number> = [];
        const fieldMap: Array<[keyof TransactionUpdate, string]> = [
          ['amountCents', 'amount_cents'],
          ['description', 'description'],
          ['categoryId', 'category_id'],
          ['cardId', 'card_id'],
          ['date', 'date'],
        ];

        for (const [field, column] of fieldMap) {
          const value = input[field];
          if (value !== undefined) {
            columns.push(`${column} = ?`);
            values.push(value);
          }
        }

        // IDOR-safe: the store's UPDATE includes user_id, so a cross-owner id
        // changes zero rows; we reject that as a 404 rather than touch a row.
        const changes = store.updateTransaction(transactionId, columns, values);
        if (changes !== 1) {
          throw new RequestError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found.');
        }
        invalidateInsightCacheForDates(store, [existing.date, input.date ?? existing.date]);
      })(id.data, update.data);

      response.json({ transaction: store.getTransaction(id.data) });
    } catch (error) {
      handleRouteError(response, error);
    }
  });

  router.delete('/:id', (request, response) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success) {
      sendValidationError(response, id.error);
      return;
    }

    const store = createUserStore(database, request.userId!);
    const existing = store.getTransaction(id.data);
    if (!existing) {
      response.status(404).json({
        error: { code: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found.' },
      });
      return;
    }
    database.transaction(() => {
      store.deleteTransaction(id.data);
      invalidateInsightCacheForDates(store, [existing.date]);
    })();

    response.status(204).send();
  });

  return router;
}