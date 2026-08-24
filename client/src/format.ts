const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const currencyCents = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Whole-dollar display for headline figures (no cents noise on the overview).
export function formatDollars(cents: number): string {
  return currency.format(cents / 100);
}

// Precise display for individual transaction amounts.
export function formatCents(cents: number): string {
  return currencyCents.format(cents / 100);
}

export function formatSignedDollars(cents: number): string {
  const sign = cents > 0 ? '+' : cents < 0 ? '−' : '';
  return `${sign}${formatDollars(Math.abs(cents))}`;
}

export function formatShare(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(0)}%`;
}

export function formatMonth(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

export function formatShortDate(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return `${MONTHS[month - 1].slice(0, 3)} ${day}`;
}
