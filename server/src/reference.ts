import { Router } from 'express';
import type Database from 'better-sqlite3';

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

// Read-only lookup data the client needs to populate the add-transaction form.
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

  return router;
}
