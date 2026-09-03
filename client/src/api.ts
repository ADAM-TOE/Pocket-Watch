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

export type AuthUser = { id: number; email: string };

// A custom Error subclass that remembers the HTTP status. This lets callers tell
// "the session died" (401) apart from other failures without string-matching.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Pull the server's { error: { message } } out of a failed response, or fall back.
async function errorMessage(response: Response, fallback: string): Promise<string> {
  const detail = await response.json().catch(() => null);
  return detail?.error?.message ?? fallback;
}

async function getJson<T>(url: string): Promise<T> {
  // credentials:'include' sends the session cookie, so data loads run as the
  // signed-in user even if the client is served from a different origin in dev.
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response, `Request failed: ${response.status}`));
  }
  return response.json() as Promise<T>;
}

export function fetchReference(): Promise<Reference> {
  return getJson<Reference>('/api/reference');
}

export type NewCard = { name: string; nickname?: string; color?: string };

export async function createCard(input: NewCard): Promise<Card> {
  const response = await fetch('/api/reference/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error?.message ?? `Could not add card (${response.status}).`);
  }
  const data = (await response.json()) as { card: Card };
  return data.card;
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
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error?.message ?? `Could not save transaction (${response.status}).`);
  }
}

export async function updateTransaction(
  id: number,
  input: Partial<NewTransaction>,
): Promise<Transaction> {
  const response = await fetch(`/api/transactions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error?.message ?? `Could not update transaction (${response.status}).`);
  }
  const data = (await response.json()) as { transaction: Transaction };
  return data.transaction;
}

export async function deleteTransaction(id: number): Promise<void> {
  const response = await fetch(`/api/transactions/${id}`, { method: 'DELETE', credentials: 'include' });
  if (!response.ok && response.status !== 204) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error?.message ?? `Could not delete transaction (${response.status}).`);
  }
}

// ---------- Auth ----------

// Returns the signed-in user, or null when there is no valid session (401).
// Any other failure is a real error and is thrown.
export async function fetchMe(): Promise<AuthUser | null> {
  const response = await fetch('/api/auth/me', { credentials: 'include' });
  if (response.status === 401) return null;
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response, 'Could not check sign-in status.'));
  }
  const data = (await response.json()) as { user: AuthUser };
  return data.user;
}

// Shared POST helper for the auth endpoints that return { user } on success.
async function postAuth(path: string, body: unknown, fallback: string): Promise<AuthUser> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response, fallback));
  }
  const data = (await response.json()) as { user: AuthUser };
  return data.user;
}

export function login(email: string, password: string): Promise<AuthUser> {
  return postAuth('/api/auth/login', { email, password }, 'Could not sign in.');
}

// Completes the forced first-login password set for a must_set_pw account.
export function setPassword(email: string, password: string): Promise<AuthUser> {
  return postAuth('/api/auth/set-password', { email, password }, 'Could not set your password.');
}

// Consumes a one-time recovery code and sets a new password.
export function recover(email: string, code: string, password: string): Promise<AuthUser> {
  return postAuth('/api/auth/recover', { email, code, password }, 'Could not reset your password.');
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
}
