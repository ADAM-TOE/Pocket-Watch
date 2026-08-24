import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getDashboardSummary } from './dashboard.js';
import { initSchema } from './db.js';
import { createSnapshot, runBackup } from './backup.js';

function seedDatabase(database: Database.Database): void {
  initSchema(database);
  const categoryId = Number(database.prepare(`
    INSERT INTO categories (name, icon, color) VALUES ('Dining', 'fork', '#ff0000')
  `).run().lastInsertRowid);
  const cardId = Number(database.prepare(`
    INSERT INTO cards (name, nickname, color) VALUES ('Test Card', 'Test', '#000000')
  `).run().lastInsertRowid);
  const insert = database.prepare(`
    INSERT INTO transactions (amount_cents, description, category_id, card_id, date)
    VALUES (?, ?, ?, ?, ?)
  `);
  insert.run(7_500, 'August dinner', categoryId, cardId, '2026-08-10');
  insert.run(3_200, 'August lunch', categoryId, cardId, '2026-08-18');
  insert.run(5_000, 'July dinner', categoryId, cardId, '2026-07-10');
}

test('a snapshot restores into a clean database with identical rows and monthly totals', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'pocket-watch-backup-'));
  const source = new Database(join(workDir, 'source.db'));
  try {
    seedDatabase(source);
    const period = { year: 2026, month: 8 };
    const sourceCounts = {
      transactions: (source.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count,
      categories: (source.prepare('SELECT COUNT(*) AS count FROM categories').get() as { count: number }).count,
      cards: (source.prepare('SELECT COUNT(*) AS count FROM cards').get() as { count: number }).count,
    };
    const sourceSpent = getDashboardSummary(source, period, '2026-08-20').totals.spentCents;

    const snapshotPath = join(workDir, 'snapshot.db');
    await createSnapshot(source, snapshotPath);

    const restored = new Database(snapshotPath, { readonly: true });
    try {
      assert.equal(
        (restored.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count,
        sourceCounts.transactions,
      );
      assert.equal(
        (restored.prepare('SELECT COUNT(*) AS count FROM categories').get() as { count: number }).count,
        sourceCounts.categories,
      );
      assert.equal(
        (restored.prepare('SELECT COUNT(*) AS count FROM cards').get() as { count: number }).count,
        sourceCounts.cards,
      );
      assert.equal(getDashboardSummary(restored, period, '2026-08-20').totals.spentCents, sourceSpent);
      assert.equal(sourceSpent, 10_700);
    } finally {
      restored.close();
    }
  } finally {
    source.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('runBackup writes a snapshot file and uploads only when an uploader is provided', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'pocket-watch-backup-'));
  const source = new Database(join(workDir, 'source.db'));
  try {
    seedDatabase(source);

    const uploaded: string[] = [];
    const withUploader = await runBackup({
      database: source,
      snapshotDir: workDir,
      timestamp: () => '2026-08-24-000000',
      uploader: async (filePath) => { uploaded.push(filePath); },
    });
    assert.equal(withUploader.uploaded, true);
    assert.equal(existsSync(withUploader.snapshotPath), true);
    assert.deepEqual(uploaded, [withUploader.snapshotPath]);

    const withoutUploader = await runBackup({
      database: source,
      snapshotDir: workDir,
      timestamp: () => '2026-08-24-000001',
    });
    assert.equal(withoutUploader.uploaded, false);
    assert.equal(existsSync(withoutUploader.snapshotPath), true);
  } finally {
    source.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});
