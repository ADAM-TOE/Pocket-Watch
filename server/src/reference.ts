import { Router, type Response } from 'express';
import type Database from 'better-sqlite3';
import { z } from 'zod';

type CardRow = {
  id: number;
  name: string;
  nickname: string | null;
  color: string;
};

type CategoryRow = {
  id: number;
  name: string;
  icon: string;
  color: string;
};

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

  router.get('/', (_request, response) => {
    const cards = database.prepare(`
      SELECT id, name, nickname, color
      FROM cards
      ORDER BY id
    `).all() as CardRow[];
    const categories = database.prepare(`
      SELECT id, name, icon, color
      FROM categories
      ORDER BY name, id
    `).all() as CategoryRow[];

    response.json({ cards, categories });
  });

  router.post('/cards', (request, response) => {
    const parsed = createCardSchema.safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }

    const { name, nickname, color } = parsed.data;
    const result = database.prepare(`
      INSERT INTO cards (name, nickname, color)
      VALUES (?, ?, ?)
    `).run(name, nickname ?? null, color ?? '#888888');

    const card = database.prepare(`
      SELECT id, name, nickname, color
      FROM cards
      WHERE id = ?
    `).get(Number(result.lastInsertRowid)) as CardRow;

    response.status(201).json({ card });
  });

  return router;
}
