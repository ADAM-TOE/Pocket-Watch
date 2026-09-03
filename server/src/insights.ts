import { Router, type Response } from 'express';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getDashboardSummary, getHouseholdDate, type Period } from './dashboard.js';
import { createUserStore, type UserStore } from './store.js';

const periodSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
}).strict();

const modelOutputSchema = z.object({
  insights: z.array(z.object({
    candidateId: z.string().min(1),
    evidenceFactIds: z.array(z.string().min(1)).min(1),
    text: z.string().min(1).max(240),
  }).strict()).max(3),
}).strict();

const renderedInsightSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  evidence: z.object({
    factIds: z.array(z.string().min(1)),
    figures: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      valueCents: z.number().int(),
    }).strict()),
    filters: z.object({
      year: z.number().int(),
      month: z.number().int(),
      categoryId: z.number().int().positive().optional(),
    }).strict(),
  }).strict(),
}).strict();

type EvidenceFact = {
  id: string;
  label: string;
  valueCents: number;
};

export type CandidateFact = {
  id: string;
  kind: 'category_delta' | 'total_delta' | 'category_overspent';
  allowedTemplates: string[];
  placeholders: Record<string, string>;
  evidenceFacts: EvidenceFact[];
  filters: { year: number; month: number; categoryId?: number };
};

export type InsightModelInput = {
  period: string;
  candidateFacts: CandidateFact[];
  allowedPlaceholders: string[];
  maximumInsights: 3;
  tone: 'concise-neutral';
};

export type InsightModel = {
  rewrite(input: InsightModelInput, signal: AbortSignal): Promise<unknown>;
};

const disabledModel: InsightModel = {
  async rewrite() {
    throw new Error('Insight model is not configured.');
  },
};

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

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

function renderTemplate(template: string, placeholders: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (match, name: string) =>
    placeholders[name] ?? match);
}

export function buildCandidateFacts(
  summary: ReturnType<typeof getDashboardSummary>,
): CandidateFact[] {
  if (
    summary.totals.currentComparisonSpentCents - summary.totals.previousSpentCents
      !== summary.totals.deltaCents
  ) {
    return [];
  }
  if (summary.categories.some((category) =>
    category.comparisonSpentCents - category.previousSpentCents !== category.deltaCents
    || (category.budgetCents !== null
      && category.budgetCents - category.spentCents !== category.remainingCents))) {
    return [];
  }

  const categoryDeltas = summary.categories
    .filter((category) => category.deltaCents !== 0)
    .sort((left, right) => Math.abs(right.deltaCents) - Math.abs(left.deltaCents))
    .map((category): CandidateFact => {
      const direction = category.deltaCents > 0 ? 'higher' : 'lower';
      return {
        id: `category-delta-${category.categoryId}`,
        kind: 'category_delta',
        allowedTemplates: [
          '{{categoryName}} spending is {{deltaAmount}} {{direction}} than the same period last month.',
          'Compared with the same period last month, {{categoryName}} spending is {{direction}} by {{deltaAmount}}.',
        ],
        placeholders: {
          categoryName: category.name,
          deltaAmount: formatCurrency(Math.abs(category.deltaCents)),
          direction,
        },
        evidenceFacts: [
          { id: `category-${category.categoryId}-current`, label: 'Current period', valueCents: category.comparisonSpentCents },
          { id: `category-${category.categoryId}-previous`, label: 'Previous period', valueCents: category.previousSpentCents },
          { id: `category-${category.categoryId}-delta`, label: 'Change', valueCents: category.deltaCents },
        ],
        filters: {
          year: summary.period.year,
          month: summary.period.month,
          categoryId: category.categoryId,
        },
      };
    });

  const overspentCategories = summary.categories
    .filter((category) => category.remainingCents !== null && category.remainingCents < 0)
    .sort((left, right) => (left.remainingCents ?? 0) - (right.remainingCents ?? 0))
    .map((category): CandidateFact => ({
      id: `category-overspent-${category.categoryId}`,
      kind: 'category_overspent',
      allowedTemplates: [
        '{{categoryName}} spending is {{overAmount}} over its monthly budget.',
        '{{categoryName}} is over its monthly budget by {{overAmount}}.',
      ],
      placeholders: {
        categoryName: category.name,
        overAmount: formatCurrency(Math.abs(category.remainingCents ?? 0)),
      },
      evidenceFacts: [
        { id: `category-${category.categoryId}-spent`, label: 'Spent', valueCents: category.spentCents },
        { id: `category-${category.categoryId}-budget`, label: 'Budget', valueCents: category.budgetCents ?? 0 },
        { id: `category-${category.categoryId}-remaining`, label: 'Remaining', valueCents: category.remainingCents ?? 0 },
      ],
      filters: {
        year: summary.period.year,
        month: summary.period.month,
        categoryId: category.categoryId,
      },
    }));

  const totalDelta: CandidateFact[] = summary.totals.deltaCents === 0 ? [] : [{
    id: 'total-delta',
    kind: 'total_delta',
    allowedTemplates: [
      'Total spending is {{deltaAmount}} {{direction}} than the same period last month.',
      'Compared with the same period last month, total spending is {{direction}} by {{deltaAmount}}.',
    ],
    placeholders: {
      deltaAmount: formatCurrency(Math.abs(summary.totals.deltaCents)),
      direction: summary.totals.deltaCents > 0 ? 'higher' : 'lower',
    },
    evidenceFacts: [
      { id: 'total-current', label: 'Current period', valueCents: summary.totals.currentComparisonSpentCents },
      { id: 'total-previous', label: 'Previous period', valueCents: summary.totals.previousSpentCents },
      { id: 'total-delta', label: 'Change', valueCents: summary.totals.deltaCents },
    ],
    filters: { year: summary.period.year, month: summary.period.month },
  }];

  return [...categoryDeltas, ...overspentCategories, ...totalDelta].slice(0, 8);
}

function exactEvidenceMatch(candidate: CandidateFact, evidenceFactIds: string[]): boolean {
  const expected = candidate.evidenceFacts.map((fact) => fact.id).sort();
  return [...evidenceFactIds].sort().every((id, index) => id === expected[index])
    && evidenceFactIds.length === expected.length;
}

function validateAndRender(output: unknown, candidates: CandidateFact[]) {
  const parsed = modelOutputSchema.safeParse(output);
  if (!parsed.success) return null;

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const insights = [];
  for (const modelInsight of parsed.data.insights) {
    const candidate = byId.get(modelInsight.candidateId);
    if (
      !candidate
      || seen.has(candidate.id)
      || !candidate.allowedTemplates.includes(modelInsight.text)
      || /\d/.test(modelInsight.text)
      || !exactEvidenceMatch(candidate, modelInsight.evidenceFactIds)
    ) {
      return null;
    }
    seen.add(candidate.id);
    insights.push({
      id: candidate.id,
      text: renderTemplate(modelInsight.text, candidate.placeholders),
      evidence: {
        factIds: modelInsight.evidenceFactIds,
        figures: candidate.evidenceFacts,
        filters: candidate.filters,
      },
    });
  }
  return insights;
}

function fallbackInsights(candidates: CandidateFact[]) {
  return candidates.slice(0, 3).map((candidate) => ({
    id: candidate.id,
    text: renderTemplate(candidate.allowedTemplates[0], candidate.placeholders),
    evidence: {
      factIds: candidate.evidenceFacts.map((fact) => fact.id),
      figures: candidate.evidenceFacts,
      filters: candidate.filters,
    },
  }));
}

function sourceHash(candidates: CandidateFact[]): string {
  return createHash('sha256').update(JSON.stringify(candidates)).digest('hex');
}

function readCachedInsights(
  store: UserStore,
  period: Period,
  hash: string,
) {
  const cached = store.readInsightCache(period.year, period.month);
  if (!cached || cached.sourceHash !== hash) return null;

  try {
    const parsed = z.array(renderedInsightSchema).safeParse(JSON.parse(cached.payloadJson));
    if (parsed.success) return parsed.data;
  } catch {
    // Corrupt cache entries are discarded and regenerated below.
  }
  store.deleteInsightCache(period.year, period.month);
  return null;
}

function writeCachedInsights(
  store: UserStore,
  period: Period,
  hash: string,
  insights: z.infer<typeof renderedInsightSchema>[],
): void {
  store.writeInsightCache(period.year, period.month, hash, JSON.stringify(insights));
}

export function invalidateInsightCache(store: UserStore, period: Period): void {
  store.deleteInsightCache(period.year, period.month);
}

export function invalidateInsightCacheForDates(store: UserStore, dates: string[]): void {
  const periods = new Map<string, Period>();
  for (const date of dates) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
    if (match) {
      const period = { year: Number(match[1]), month: Number(match[2]) };
      periods.set(`${period.year}-${period.month}`, period);
    }
  }
  for (const period of periods.values()) invalidateInsightCache(store, period);
}

export function createInsightsRouter(
  database: Database.Database,
  model: InsightModel = disabledModel,
  today: () => string = getHouseholdDate,
  timeoutMs = 5_000,
): Router {
  const router = Router();

  router.get('/', async (request, response) => {
    const period = periodSchema.safeParse(request.query);
    if (!period.success) {
      sendValidationError(response, period.error);
      return;
    }

    const store = createUserStore(database, request.userId!);
    const summary = getDashboardSummary(store, period.data as Period, today());
    const candidates = buildCandidateFacts(summary);
    if (candidates.length === 0) {
      response.json({ source: 'fallback', insights: [] });
      return;
    }

    const hash = sourceHash(candidates);
    const cached = readCachedInsights(store, period.data, hash);
    if (cached) {
      response.json({ source: 'cache', insights: cached });
      return;
    }

    const input: InsightModelInput = {
      period: `${period.data.year}-${String(period.data.month).padStart(2, '0')}`,
      candidateFacts: candidates,
      allowedPlaceholders: [...new Set(candidates.flatMap((candidate) =>
        Object.keys(candidate.placeholders).map((name) => `{{${name}}}`)))],
      maximumInsights: 3,
      tone: 'concise-neutral',
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const output = await model.rewrite(input, controller.signal);
      const insights = validateAndRender(output, candidates);
      if (insights) {
        writeCachedInsights(store, period.data, hash, insights);
        response.json({ source: 'model', insights });
      } else {
        response.json({ source: 'fallback', insights: fallbackInsights(candidates) });
      }
    } catch {
      response.json({ source: 'fallback', insights: fallbackInsights(candidates) });
    } finally {
      clearTimeout(timeout);
    }
  });

  return router;
}