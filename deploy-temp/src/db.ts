import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');

export function createDatabase(filename: string): Database.Database {
  mkdirSync(dirname(filename), { recursive: true });
  const database = new Database(filename);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  return database;
}

// DATABASE_PATH lets Azure App Service point at persistent /home storage.
const databasePath = process.env.DATABASE_PATH?.trim() || join(dataDir, 'budget.db');
export const db = createDatabase(databasePath);

function hasColumn(database: Database.Database, table: string, column: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

function migrateLegacyMoneyColumns(database: Database.Database): void {
  if (hasColumn(database, 'transactions', 'amount') && !hasColumn(database, 'transactions', 'amount_cents')) {
    database.exec(`
      CREATE TABLE transactions_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
        description TEXT NOT NULL,
        category_id INTEGER NOT NULL REFERENCES categories(id),
        card_id INTEGER NOT NULL REFERENCES cards(id),
        date TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO transactions_v2 (
        id, amount_cents, description, category_id, card_id, date, source, created_at, updated_at
      )
      SELECT
        id,
        CAST(ROUND(amount * 100) AS INTEGER),
        description,
        category_id,
        card_id,
        date,
        source,
        created_at,
        created_at
      FROM transactions;

      DROP TABLE transactions;
      ALTER TABLE transactions_v2 RENAME TO transactions;
    `);
  }

  if (hasColumn(database, 'budgets', 'amount') && !hasColumn(database, 'budgets', 'amount_cents')) {
    database.exec(`
      CREATE TABLE budgets_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
        category_id INTEGER REFERENCES categories(id),
        amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO budgets_v2 (id, year, month, category_id, amount_cents, created_at)
      SELECT id, year, month, category_id, CAST(ROUND(amount * 100) AS INTEGER), created_at
      FROM budgets;

      DROP TABLE budgets;
      ALTER TABLE budgets_v2 RENAME TO budgets;
    `);
  }
}

export function initSchema(database: Database.Database = db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      nickname TEXT,
      color TEXT NOT NULL DEFAULT '#888888',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      icon TEXT NOT NULL DEFAULT '💸',
      color TEXT NOT NULL DEFAULT '#888888',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      description TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      card_id INTEGER NOT NULL REFERENCES cards(id),
      date TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- category_id NULL means the overall monthly total budget.
    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
      category_id INTEGER REFERENCES categories(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS insight_cache (
      year INTEGER NOT NULL,
      month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
      source_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (year, month)
    );
  `);

  database.transaction(() => migrateLegacyMoneyColumns(database))();

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_period_cat
      ON budgets(year, month, IFNULL(category_id, 0));
    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);
    CREATE INDEX IF NOT EXISTS idx_tx_card ON transactions(card_id);
  `);
}
