export type Card = { id: number; name: string; nickname: string | null; color: string };
export type Category = { id: number; name: string; icon: string; color: string };
export type Reference = { cards: Card[]; categories: Category[] };

export type DashboardSummary = {
  period: {
    year: number;
    month: number;
    throughDay: number;
    comparison: { year: number; month: number; throughDay: number };
  };
  totals: {
    spentCents: number;
    budgetCents: number | null;
    remainingCents: number | null;
    currentComparisonSpentCents: number;
    previousSpentCents: number;
    deltaCents: number;
  };
  recentTransactions: Array<{
    id: number;
    amountCents: number;
    description: string;
    categoryId: number;
    categoryName: string;
    categoryColor: string;
    cardId: number;
    cardName: string;
    date: string;
  }>;
  categories: Array<{
    categoryId: number;
    name: string;
    color: string;
    spentCents: number;
    comparisonSpentCents: number;
    previousSpentCents: number;
    deltaCents: number;
    shareBasisPoints: number;
    budgetCents: number | null;
    remainingCents: number | null;
  }>;
  trend: Array<{ day: number; currentCumulativeCents: number; previousCumulativeCents: number }>;
};

export type Insight = {
  id: string;
  text: string;
  evidence: {
    factIds: string[];
    figures: Array<{ id: string; label: string; valueCents: number }>;
    filters: { year: number; month: number; categoryId?: number };
  };
};

export type NewTransaction = {
  amountCents: number;
  description: string;
  categoryId: number;
  cardId: number;
  date: string;
};

export type Transaction = {
  id: number;
  amountCents: number;
  description: string;
  categoryId: number;
  categoryName: string;
  cardId: number;
  cardName: string;
  date: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export function fetchReference(): Promise<Reference> {
  return getJson<Reference>('/api/reference');
}

export function fetchDashboard(year: number, month: number): Promise<DashboardSummary> {
  return getJson<DashboardSummary>(`/api/dashboard?year=${year}&month=${month}`);
}

export function fetchInsights(year: number, month: number): Promise<{ insights: Insight[] }> {
  return getJson<{ insights: Insight[] }>(`/api/insights?year=${year}&month=${month}`);
}

export function fetchTransactions(
  limit: number,
  offset: number,
): Promise<{ transactions: Transaction[]; pagination: { limit: number; offset: number } }> {
  return getJson(`/api/transactions?limit=${limit}&offset=${offset}`);
}

export async function createTransaction(input: NewTransaction): Promise<void> {
  const response = await fetch('/api/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error?.message ?? `Could not save transaction (${response.status}).`);
  }
}
