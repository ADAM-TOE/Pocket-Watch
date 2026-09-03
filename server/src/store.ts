import type Database from 'better-sqlite3';

// The single data-access layer (the "choke-point"). Every SQL statement that
// touches a per-user table is built here, and every one injects user_id from the
// userId this store was created with — which always comes from req.userId, never
// from a request body. Routes call these methods instead of writing SQL, so a
// route physically cannot forget the owner filter.
//
// Categories are a shared/global lookup table (confirmed decision), so their
// helpers are not owner-scoped.

export type CardRow = {
  id: number;
  name: string;
  nickname: string | null;
  color: string;
};

export type TransactionRow = {
  id: number;
  amountCents: number;
  description: string;
  categoryId: number;
  categoryName: string;
  categoryColor: string;
  cardId: number;
  cardName: string;
  date: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type NewTransaction = {
  amountCents: number;
  description: string;
  categoryId: number;
  cardId: number;
  date: string;
};

const transactionSelect = `
  SELECT
    transactions.id,
    transactions.amount_cents AS amountCents,
    transactions.description,
    transactions.category_id AS categoryId,
    categories.name AS categoryName,
    categories.color AS categoryColor,
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

// Global (not owner-scoped) category lookups.
export function categoryExists(database: Database.Database, categoryId: number): boolean {
  return database.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId) !== undefined;
}

export function listCategories(database: Database.Database): Array<{
  id: number;
  name: string;
  icon: string;
  color: string;
}> {
  return database
    .prepare('SELECT id, name, icon, color FROM categories ORDER BY name, id')
    .all() as Array<{ id: number; name: string; icon: string; color: string }>;
}

export type UserStore = ReturnType<typeof createUserStore>;

export function createUserStore(database: Database.Database, userId: number) {
  return {
    userId,

    // ---- cards ----
    listCards(): CardRow[] {
      return database
        .prepare('SELECT id, name, nickname, color FROM cards WHERE user_id = ? ORDER BY id')
        .all(userId) as CardRow[];
    },
    getCard(id: number): CardRow | undefined {
      return database
        .prepare('SELECT id, name, nickname, color FROM cards WHERE id = ? AND user_id = ?')
        .get(id, userId) as CardRow | undefined;
    },
    cardExists(id: number): boolean {
      return (
        database.prepare('SELECT 1 FROM cards WHERE id = ? AND user_id = ?').get(id, userId) !==
        undefined
      );
    },
    createCard(name: string, nickname: string | null, color: string): CardRow {
      const result = database
        .prepare('INSERT INTO cards (user_id, name, nickname, color) VALUES (?, ?, ?, ?)')
        .run(userId, name, nickname, color);
      return this.getCard(Number(result.lastInsertRowid)) as CardRow;
    },

    // ---- transactions ----
    listTransactions(range: { start: string; end: string } | null, limit: number, offset: number): TransactionRow[] {
      if (range) {
        return database
          .prepare(
            `${transactionSelect}
             WHERE transactions.user_id = ? AND transactions.date >= ? AND transactions.date < ?
             ORDER BY transactions.date DESC, transactions.id DESC
             LIMIT ? OFFSET ?`,
          )
          .all(userId, range.start, range.end, limit, offset) as TransactionRow[];
      }
      return database
        .prepare(
          `${transactionSelect}
           WHERE transactions.user_id = ?
           ORDER BY transactions.date DESC, transactions.id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(userId, limit, offset) as TransactionRow[];
    },
    // Rows in a date window, oldest-first math handled by callers. Owner-scoped.
    readTransactionsBetween(start: string, end: string): TransactionRow[] {
      return database
        .prepare(
          `${transactionSelect}
           WHERE transactions.user_id = ? AND transactions.date >= ? AND transactions.date < ?
           ORDER BY transactions.date DESC, transactions.id DESC`,
        )
        .all(userId, start, end) as TransactionRow[];
    },
    getTransaction(id: number): TransactionRow | undefined {
      return database
        .prepare(`${transactionSelect} WHERE transactions.id = ? AND transactions.user_id = ?`)
        .get(id, userId) as TransactionRow | undefined;
    },
    insertTransaction(input: NewTransaction): number {
      const result = database
        .prepare(
          `INSERT INTO transactions (user_id, amount_cents, description, category_id, card_id, date)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, input.amountCents, input.description, input.categoryId, input.cardId, input.date);
      return Number(result.lastInsertRowid);
    },
    // IDOR-safe update: the WHERE includes user_id, so a cross-owner id changes
    // zero rows. Returns the number of rows changed for the caller to assert on.
    updateTransaction(id: number, columns: string[], values: Array<string | number>): number {
      const result = database
        .prepare(
          `UPDATE transactions
           SET ${columns.join(', ')}, updated_at = datetime('now')
           WHERE id = ? AND user_id = ?`,
        )
        .run(...values, id, userId);
      return result.changes;
    },
    deleteTransaction(id: number): number {
      const result = database
        .prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?')
        .run(id, userId);
      return result.changes;
    },

    // ---- budgets ----
    totalBudget(year: number, month: number): number | undefined {
      const row = database
        .prepare(
          `SELECT amount_cents AS amountCents FROM budgets
           WHERE user_id = ? AND year = ? AND month = ? AND category_id IS NULL`,
        )
        .get(userId, year, month) as { amountCents: number } | undefined;
      return row?.amountCents;
    },
    categoryBudgets(year: number, month: number): Array<{ categoryId: number; amountCents: number }> {
      return database
        .prepare(
          `SELECT category_id AS categoryId, amount_cents AS amountCents FROM budgets
           WHERE user_id = ? AND year = ? AND month = ? AND category_id IS NOT NULL`,
        )
        .all(userId, year, month) as Array<{ categoryId: number; amountCents: number }>;
    },
    budgetAllocationsWithSpend(
      year: number,
      month: number,
      start: string,
      end: string,
    ): Array<{ categoryId: number; categoryName: string; amountCents: number; spentCents: number }> {
      return database
        .prepare(
          `SELECT
             budgets.category_id AS categoryId,
             categories.name AS categoryName,
             budgets.amount_cents AS amountCents,
             COALESCE(SUM(transactions.amount_cents), 0) AS spentCents
           FROM budgets
           JOIN categories ON categories.id = budgets.category_id
           LEFT JOIN transactions
             ON transactions.category_id = budgets.category_id
             AND transactions.user_id = budgets.user_id
             AND transactions.date >= ?
             AND transactions.date < ?
           WHERE budgets.user_id = ? AND budgets.year = ? AND budgets.month = ?
             AND budgets.category_id IS NOT NULL
           GROUP BY budgets.category_id, categories.name, budgets.amount_cents
           ORDER BY categories.name, budgets.category_id`,
        )
        .all(start, end, userId, year, month) as Array<{
        categoryId: number;
        categoryName: string;
        amountCents: number;
        spentCents: number;
      }>;
    },
    replaceBudgets(
      year: number,
      month: number,
      totalBudgetCents: number,
      allocations: Array<{ categoryId: number; amountCents: number }>,
    ): void {
      database
        .prepare('DELETE FROM budgets WHERE user_id = ? AND year = ? AND month = ?')
        .run(userId, year, month);
      database
        .prepare(
          `INSERT INTO budgets (user_id, year, month, category_id, amount_cents)
           VALUES (?, ?, ?, NULL, ?)`,
        )
        .run(userId, year, month, totalBudgetCents);
      const insertAllocation = database.prepare(
        `INSERT INTO budgets (user_id, year, month, category_id, amount_cents)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const allocation of allocations) {
        insertAllocation.run(userId, year, month, allocation.categoryId, allocation.amountCents);
      }
    },

    // ---- insight cache ----
    readInsightCache(year: number, month: number): { sourceHash: string; payloadJson: string } | undefined {
      return database
        .prepare(
          `SELECT source_hash AS sourceHash, payload_json AS payloadJson
           FROM insight_cache WHERE user_id = ? AND year = ? AND month = ?`,
        )
        .get(userId, year, month) as { sourceHash: string; payloadJson: string } | undefined;
    },
    writeInsightCache(year: number, month: number, hash: string, payloadJson: string): void {
      database
        .prepare(
          `INSERT INTO insight_cache (user_id, year, month, source_hash, payload_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, year, month) DO UPDATE SET
             source_hash = excluded.source_hash,
             payload_json = excluded.payload_json,
             created_at = datetime('now')`,
        )
        .run(userId, year, month, hash, payloadJson);
    },
    deleteInsightCache(year: number, month: number): void {
      database
        .prepare('DELETE FROM insight_cache WHERE user_id = ? AND year = ? AND month = ?')
        .run(userId, year, month);
    },
  };
}
