import { db, initSchema } from './db.js';

initSchema();

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

const cardCount = (db.prepare('SELECT COUNT(*) AS c FROM cards').get() as { c: number }).c;
if (cardCount === 0) {
  const insertCard = db.prepare('INSERT INTO cards (name, nickname, color) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const c of cards) insertCard.run(c.name, c.nickname, c.color);
  })();
  console.log(`Seeded ${cards.length} cards`);
} else {
  console.log(`Cards already present (${cardCount}); skipping`);
}

const insertCat = db.prepare('INSERT OR IGNORE INTO categories (name, icon, color) VALUES (?, ?, ?)');
db.transaction(() => {
  for (const c of categories) insertCat.run(c.name, c.icon, c.color);
})();
console.log(`Seeded categories (${categories.length})`);

const now = new Date();
const year = now.getFullYear();
const month = now.getMonth() + 1;
const existingBudget = db
  .prepare('SELECT id FROM budgets WHERE year = ? AND month = ? AND category_id IS NULL')
  .get(year, month);
if (!existingBudget) {
  db.prepare('INSERT INTO budgets (year, month, category_id, amount_cents) VALUES (?, ?, NULL, ?)').run(
    year,
    month,
    200_000,
  );
  console.log(`Seeded $2000 total budget for ${year}-${String(month).padStart(2, '0')}`);
} else {
  console.log('Budget already exists for current month; skipping');
}

console.log('Seed complete.');
