import { Router, type Response } from 'express';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { invalidateInsightCacheForDates } from './insights.js';

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

type TransactionRow = {
  id: number;
  amountCents: number;
  description: string;
  categoryId: number;
  categoryName: string;
  cardId: number;
  cardName: string;
  date: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const transactionSelect = `
  SELECT
    transactions.id,
    transactions.amount_cents AS amountCents,
    transactions.description,
    transactions.category_id AS categoryId,
    categories.name AS categoryName,
    transactions.card_id AS cardId,
    cards.name AS cardName,
    transactions.date,
    transactions.source,
    transactions.created_at AS createdAt,
    transactions.updated_at AS updatedAt
  FROM transactions
  JOIN categories ON categories.id = transactions.category_id
  JOIN cards ON cards.id = transactions.card_id
`;

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

function assertReferencesExist(
  database: Database.Database,
  categoryId: number,
  cardId: number,
): void {
  const category = database.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId);
  if (!category) {
    throw new RequestError(400, 'INVALID_CATEGORY', 'The selected category does not exist.');
  }

  const card = database.prepare('SELECT 1 FROM cards WHERE id = ?').get(cardId);
  if (!card) {
    throw new RequestError(400, 'INVALID_CARD', 'The selected card does not exist.');
  }
}

function getTransaction(database: Database.Database, id: number): TransactionRow | undefined {
  return database.prepare(`${transactionSelect} WHERE transactions.id = ?`).get(id) as
    | TransactionRow
    | undefined;
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
    const parameters: Array<string | number> = [];
    let where = '';

    if (year !== undefined && month !== undefined) {
      const following = nextMonth(year, month);
      where = 'WHERE transactions.date >= ? AND transactions.date < ?';
      parameters.push(periodStart(year, month), periodStart(following.year, following.month));
    }

    parameters.push(limit, offset);
    const transactions = database.prepare(`
      ${transactionSelect}
      ${where}
      ORDER BY transactions.date DESC, transactions.id DESC
      LIMIT ? OFFSET ?
    `).all(...parameters) as TransactionRow[];

    response.json({ transactions, pagination: { limit, offset } });
  });

  router.post('/', (request, response) => {
    const parsed = createTransactionSchema.safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }

    try {
      const id = database.transaction((input: TransactionInput) => {
        assertReferencesExist(database, input.categoryId, input.cardId);
        const result = database.prepare(`
          INSERT INTO transactions (amount_cents, description, category_id, card_id, date)
          VALUES (?, ?, ?, ?, ?)
        `).run(input.amountCents, input.description, input.categoryId, input.cardId, input.date);
        invalidateInsightCacheForDates(database, [input.date]);
        return Number(result.lastInsertRowid);
      })(parsed.data);

      response.status(201).json({ transaction: getTransaction(database, id) });
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

    try {
      database.transaction((transactionId: number, input: TransactionUpdate) => {
        const existing = getTransaction(database, transactionId);
        if (!existing) {
          throw new RequestError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found.');
        }

        assertReferencesExist(
          database,
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

        values.push(transactionId);
        database.prepare(`
          UPDATE transactions
          SET ${columns.join(', ')}, updated_at = datetime('now')
          WHERE id = ?
        `).run(...values);
        invalidateInsightCacheForDates(database, [existing.date, input.date ?? existing.date]);
      })(id.data, update.data);

      response.json({ transaction: getTransaction(database, id.data) });
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

    const existing = getTransaction(database, id.data);
    if (!existing) {
      response.status(404).json({
        error: { code: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found.' },
      });
      return;
    }
    database.transaction(() => {
      database.prepare('DELETE FROM transactions WHERE id = ?').run(id.data);
      invalidateInsightCacheForDates(database, [existing.date]);
    })();

    response.status(204).send();
  });

  return router;
}