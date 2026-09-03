import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { db, initSchema } from './db.js';

const cards = [
  { name: 'Chase Freedom Unlimited', nickname: 'Freedom', color: '#1f6fb2' },
  { name: 'Chase Sapphire Reserve', nickname: 'Sapphire', color: '#111827' },
  { name: 'Citi Custom Cash', nickname: 'Custom Cash', color: '#d1495b' },
  { name: 'Capital One Venture X', nickname: 'Venture X', color: '#2a9d8f' },
];

const categories = [
  { name: 'Groceries', icon: '🛒', color: '#4caf50' },
  { name: 'Dining', icon: '🍽️', color: '#ff7043' },
  { name: 'Transport / Gas', icon: '⛽', color: '#42a5f5' },
  { name: 'Shopping', icon: '🛍️', color: '#ab47bc' },
  { name: 'Bills / Utilities', icon: '💡', color: '#ffca28' },
  { name: 'Entertainment', icon: '🎬', color: '#ec407a' },
  { name: 'Health', icon: '💊', color: '#26a69a' },
  { name: 'Traveling', icon: '✈️', color: '#5c6bc0' },
  { name: 'Gym', icon: '🏋️', color: '#8d6e63' },
  { name: 'Amazon', icon: '📦', color: '#ff9800' },
  { name: 'Family Stuff', icon: '👨‍👩‍👧', color: '#78909c' },
  { name: 'Other', icon: '💸', color: '#9e9e9e' },
];

// Idempotent: safe to run on every server startup. Categories are a shared/global
// lookup table, so they are seeded once for everyone (not per user).
export function seedReferenceData(database: Database.Database = db): void {
  initSchema(database);

  const insertCat = database.prepare(
    'INSERT OR IGNORE INTO categories (name, icon, color) VALUES (?, ?, ?)',
  );
  database.transaction(() => {
    for (const c of categories) insertCat.run(c.name, c.icon, c.color);
  })();
  console.log(`Seeded categories (${categories.length})`);
}

// Per-user starting data: the four preloaded cards and a default $2000 total
// monthly budget for the current month, all owned by userId. Idempotent per user.
export function seedUserData(database: Database.Database, userId: number): void {
  const cardCount = (
    database.prepare('SELECT COUNT(*) AS c FROM cards WHERE user_id = ?').get(userId) as { c: number }
  ).c;
  if (cardCount === 0) {
    const insertCard = database.prepare(
      'INSERT INTO cards (user_id, name, nickname, color) VALUES (?, ?, ?, ?)',
    );
    database.transaction(() => {
      for (const c of cards) insertCard.run(userId, c.name, c.nickname, c.color);
    })();
    console.log(`Seeded ${cards.length} cards for user ${userId}`);
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const existingBudget = database
    .prepare(
      'SELECT id FROM budgets WHERE user_id = ? AND year = ? AND month = ? AND category_id IS NULL',
    )
    .get(userId, year, month);
  if (!existingBudget) {
    database
      .prepare(
        'INSERT INTO budgets (user_id, year, month, category_id, amount_cents) VALUES (?, ?, ?, NULL, ?)',
      )
      .run(userId, year, month, 200_000);
    console.log(`Seeded $2000 total budget for user ${userId} (${year}-${String(month).padStart(2, '0')})`);
  }
}

// Only run standalone when invoked directly (npm run seed), not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedReferenceData(db);
  console.log('Seed complete.');
}
