import { Router, type Response } from 'express';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { createUserStore, listCategories } from './store.js';

const createCardSchema = z.object({
  name: z.string().trim().min(1).max(60),
  nickname: z.string().trim().min(1).max(40).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).strict();

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

// Read-only lookup data plus card creation the client needs for the add-transaction form.
export function createReferenceRouter(database: Database.Database): Router {
  const router = Router();

  router.get('/', (request, response) => {
    const store = createUserStore(database, request.userId!);
    response.json({ cards: store.listCards(), categories: listCategories(database) });
  });

  router.post('/cards', (request, response) => {
    const parsed = createCardSchema.safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }

    const store = createUserStore(database, request.userId!);
    const { name, nickname, color } = parsed.data;
    const card = store.createCard(name, nickname ?? null, color ?? '#888888');
    response.status(201).json({ card });
  });

  return router;
}
