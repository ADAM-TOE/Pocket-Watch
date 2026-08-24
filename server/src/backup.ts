import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

export type SnapshotUploader = (filePath: string) => Promise<void>;

type RunBackupOptions = {
  database: Database.Database;
  snapshotDir: string;
  uploader?: SnapshotUploader;
  timestamp?: () => string;
};

export async function createSnapshot(
  database: Database.Database,
  destinationPath: string,
): Promise<{ snapshotPath: string }> {
  mkdirSync(dirname(destinationPath), { recursive: true });
  await database.backup(destinationPath);
  return { snapshotPath: destinationPath };
}

export async function runBackup(
  options: RunBackupOptions,
): Promise<{ snapshotPath: string; uploaded: boolean }> {
  const token = (options.timestamp ?? defaultTimestamp)();
  const { snapshotPath } = await createSnapshot(
    options.database,
    join(options.snapshotDir, `budget-${token}.db`),
  );

  if (options.uploader) {
    await options.uploader(snapshotPath);
    return { snapshotPath, uploaded: true };
  }
  return { snapshotPath, uploaded: false };
}

function defaultTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
