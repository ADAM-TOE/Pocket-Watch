import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createBudgetsRouter } from './budgets.js';
import { db, initSchema } from './db.js';
import { createDashboardRouter } from './dashboard.js';
import { createInsightsRouter, type InsightModel } from './insights.js';
import { createTransactionsRouter } from './transactions.js';

type AppOptions = {
  today?: () => string;
  insightModel?: InsightModel;
  insightTimeoutMs?: number;
  clientDistPath?: string;
};

export function createApp(
  database: Database.Database = db,
  options: AppOptions = {},
): express.Express {
  initSchema(database);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_request, response) => {
    const count = (sql: string) => (database.prepare(sql).get() as { count: number }).count;
    response.json({
      status: 'ok',
      db: 'connected',
      counts: {
        cards: count('SELECT COUNT(*) AS count FROM cards'),
        categories: count('SELECT COUNT(*) AS count FROM categories'),
        budgets: count('SELECT COUNT(*) AS count FROM budgets'),
      },
    });
  });

  app.use('/api/transactions', createTransactionsRouter(database));
  app.use('/api/dashboard', createDashboardRouter(database, options.today));
  app.use('/api/budgets', createBudgetsRouter(database));
  app.use('/api/insights', createInsightsRouter(
    database,
    options.insightModel,
    options.today,
    options.insightTimeoutMs,
  ));

  if (options.clientDistPath && existsSync(join(options.clientDistPath, 'index.html'))) {
    const clientDist = options.clientDistPath;
    app.use(express.static(clientDist));
    // Serve the SPA for any non-API GET so client-side navigation works on refresh.
    app.use((request, response, next) => {
      if (request.method !== 'GET' || request.path.startsWith('/api/')) {
        next();
        return;
      }
      response.sendFile(join(clientDist, 'index.html'));
    });
  }

  const invalidJsonHandler: ErrorRequestHandler = (error, _request, response, next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({
        error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' },
      });
      return;
    }
    next(error);
  };
  app.use(invalidJsonHandler);

  return app;
}