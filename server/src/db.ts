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
      user_id INTEGER NOT NULL REFERENCES users(id),
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
      user_id INTEGER NOT NULL REFERENCES users(id),
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
      user_id INTEGER NOT NULL REFERENCES users(id),
      year INTEGER NOT NULL,
      month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
      category_id INTEGER REFERENCES categories(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS insight_cache (
      user_id INTEGER NOT NULL REFERENCES users(id),
      year INTEGER NOT NULL,
      month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
      source_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, year, month)
    );

    -- Accounts. password_hash is nullable so a freshly created (or migrated)
    -- account can be forced to SET a password before login works, instead of
    -- shipping a guessable placeholder hash (which would be a backdoor).
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      must_set_pw INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Server-side sessions so we can revoke instantly (a JWT cannot be un-issued).
    -- We store a HASH of the session id, never the raw value: a DB leak must not
    -- hand out live sessions.
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    -- Brute-force ledger: recent login attempts per email + IP for throttling.
    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      ip TEXT,
      succeeded INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One-time recovery codes, stored HASHED (never plaintext) — same reasoning as
    -- session tokens: a DB leak must not hand out usable codes. Each row is
    -- consumed (used_at set) the first time its code successfully resets a password.
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      code_hash TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Passkey (WebAuthn) credentials. We store only the PUBLIC key, which is
    -- useless to a thief: the matching private key never leaves the device's
    -- secure hardware. sign_count is the authenticator's usage counter; a value
    -- that fails to increase signals a cloned authenticator (see webauthn.ts).
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      credential_id TEXT NOT NULL UNIQUE,
      public_key BLOB NOT NULL,
      sign_count INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Short-lived, single-use WebAuthn challenges. The random challenge we ask a
    -- device to sign is stored here and matched on verify, then deleted, so a
    -- captured response cannot be replayed. The row id doubles as the value of a
    -- separate HttpOnly cookie, binding the challenge to the browser that started
    -- the ceremony. user_id is set only for enrollment (a logged-in user).
    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      id TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      purpose TEXT NOT NULL,
      user_id INTEGER,
      expires_at TEXT NOT NULL
    );
  `);

  database.transaction(() => migrateLegacyMoneyColumns(database))();

  // Owner #1 must exist before we can backfill existing rows to an owner.
  migrateToUserOne(database);

  const needsOwnerColumns =
    !hasColumn(database, 'cards', 'user_id') ||
    !hasColumn(database, 'transactions', 'user_id') ||
    !hasColumn(database, 'budgets', 'user_id') ||
    !hasColumn(database, 'insight_cache', 'user_id');
  if (needsOwnerColumns) {
    // A table rebuild that drops a parent (cards) needs FK checks off; better to
    // re-enable them right after inside one transaction (SQLite's documented
    // 12-step ALTER procedure).
    database.pragma('foreign_keys = OFF');
    database.transaction(() => migrateAddOwnerColumns(database))();
    database.pragma('foreign_keys = ON');
  }

  database.exec(`
    DROP INDEX IF EXISTS idx_budget_period_cat;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_user_period_cat
      ON budgets(user_id, year, month, IFNULL(category_id, 0));
    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);
    CREATE INDEX IF NOT EXISTS idx_tx_card ON transactions(card_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_attempts_email_time ON login_attempts(email, created_at);
    CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);
    CREATE INDEX IF NOT EXISTS idx_webauthn_cred_user ON webauthn_credentials(user_id);
  `);
}

// Backfills the user_id owner column onto the per-user tables of an existing
// pre-auth database, assigning every current row to user #1. Uses the same
// table-rebuild pattern as migrateLegacyMoneyColumns. No-op on fresh databases
// (their CREATE TABLE statements already include user_id).
function migrateAddOwnerColumns(database: Database.Database): void {
  const owner = database.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as
    | { id: number }
    | undefined;
  // When there is no owner yet, the tables are empty, so zero rows are copied and
  // this literal is never assigned to a row.
  const ownerExpr = owner ? String(owner.id) : 'NULL';

  if (!hasColumn(database, 'cards', 'user_id')) {
    database.exec(`
      CREATE TABLE cards_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        nickname TEXT,
        color TEXT NOT NULL DEFAULT '#888888',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO cards_v2 (id, user_id, name, nickname, color, created_at)
      SELECT id, ${ownerExpr}, name, nickname, color, created_at FROM cards;
      DROP TABLE cards;
      ALTER TABLE cards_v2 RENAME TO cards;
    `);
  }

  if (!hasColumn(database, 'transactions', 'user_id')) {
    database.exec(`
      CREATE TABLE transactions_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
        description TEXT NOT NULL,
        category_id INTEGER NOT NULL REFERENCES categories(id),
        card_id INTEGER NOT NULL REFERENCES cards(id),
        date TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO transactions_v3 (id, user_id, amount_cents, description, category_id, card_id, date, source, created_at, updated_at)
      SELECT id, ${ownerExpr}, amount_cents, description, category_id, card_id, date, source, created_at, updated_at FROM transactions;
      DROP TABLE transactions;
      ALTER TABLE transactions_v3 RENAME TO transactions;
    `);
  }

  if (!hasColumn(database, 'budgets', 'user_id')) {
    database.exec(`
      CREATE TABLE budgets_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        year INTEGER NOT NULL,
        month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
        category_id INTEGER REFERENCES categories(id),
        amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO budgets_v3 (id, user_id, year, month, category_id, amount_cents, created_at)
      SELECT id, ${ownerExpr}, year, month, category_id, amount_cents, created_at FROM budgets;
      DROP TABLE budgets;
      ALTER TABLE budgets_v3 RENAME TO budgets;
    `);
  }

  if (!hasColumn(database, 'insight_cache', 'user_id')) {
    database.exec(`
      CREATE TABLE insight_cache_v2 (
        user_id INTEGER NOT NULL REFERENCES users(id),
        year INTEGER NOT NULL,
        month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
        source_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, year, month)
      );
      INSERT INTO insight_cache_v2 (user_id, year, month, source_hash, payload_json, created_at)
      SELECT ${ownerExpr}, year, month, source_hash, payload_json, created_at FROM insight_cache;
      DROP TABLE insight_cache;
      ALTER TABLE insight_cache_v2 RENAME TO insight_cache;
    `);
  }
}

// Bootstrap migration: a pre-auth database (real data, no accounts yet) gets a
// single owner. We store NO password hash and force must_set_pw = 1, so there is
// no guessable placeholder credential — login stays blocked until the operator
// completes the set-password step. Idempotent: once any user exists, this no-ops.
export function migrateToUserOne(database: Database.Database = db): void {
  const userCount = (database.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (userCount > 0) return;

  const dataCount = (
    database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM cards) +
          (SELECT COUNT(*) FROM transactions) +
          (SELECT COUNT(*) FROM budgets) AS c`,
      )
      .get() as { c: number }
  ).c;
  if (dataCount === 0) return;

  const email = (process.env.BOOTSTRAP_USER_EMAIL?.trim() || 'owner@pocketwatch.local').toLowerCase();
  database
    .prepare('INSERT INTO users (email, password_hash, must_set_pw) VALUES (?, NULL, 1)')
    .run(email);
}
