import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from './app.js';
import { initSchema } from './db.js';

function setup() {
  const clientDir = mkdtempSync(join(tmpdir(), 'pocket-watch-client-'));
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>POCKET WATCH APP</title>');
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  initSchema(database);
  return { clientDir, database, app: createApp(database, { clientDistPath: clientDir }) };
}

test('the built client is served at the root and for client-side routes', async () => {
  const context = setup();
  try {
    const root = await request(context.app).get('/');
    assert.equal(root.status, 200);
    assert.match(root.text, /POCKET WATCH APP/);

    const clientRoute = await request(context.app).get('/budgets');
    assert.equal(clientRoute.status, 200);
    assert.match(clientRoute.text, /POCKET WATCH APP/);
  } finally {
    context.database.close();
    rmSync(context.clientDir, { recursive: true, force: true });
  }
});

test('API routes still return JSON and are not shadowed by the SPA fallback', async () => {
  const context = setup();
  try {
    const health = await request(context.app).get('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');

    const unknownApi = await request(context.app).get('/api/does-not-exist');
    assert.equal(unknownApi.status, 404);
    assert.doesNotMatch(unknownApi.text, /POCKET WATCH APP/);
  } finally {
    context.database.close();
    rmSync(context.clientDir, { recursive: true, force: true });
  }
});
