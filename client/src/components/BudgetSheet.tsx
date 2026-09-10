import { useEffect, useState } from 'react';
import type { BudgetDetail, Category, SaveBudget } from '../api';
import { fetchBudget, saveBudget } from '../api';
import { formatDollars, formatMonth } from '../format';

type Props = {
  period: { year: number; month: number };
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
};

// Converts a cents integer to an editable dollar string ('' for none), so the
// inputs show clean values like "2000" rather than "200000".
function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return String(cents / 100);
}

// Parses a dollar string to a non-negative cents integer; blank or bad input is 0.
function inputToCents(value: string): number {
  const dollars = Number(value);
  if (!Number.isFinite(dollars) || dollars < 0) return 0;
  return Math.round(dollars * 100);
}

export function BudgetSheet({ period, categories, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState('');
  // Per-category dollar strings, keyed by category id.
  const [allocations, setAllocations] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchBudget(period.year, period.month)
      .then((budget: BudgetDetail) => {
        if (cancelled) return;
        setTotal(centsToInput(budget.totalBudgetCents ?? 0));
        const map: Record<number, string> = {};
        for (const allocation of budget.allocations) {
          map[allocation.categoryId] = centsToInput(allocation.amountCents);
        }
        setAllocations(map);
        setLoading(false);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : 'Could not load budget.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period.year, period.month]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const totalCents = inputToCents(total);
  const allocatedCents = categories.reduce(
    (sum, category) => sum + inputToCents(allocations[category.id] ?? ''),
    0,
  );
  const leftoverCents = totalCents - allocatedCents;
  const overAllocated = leftoverCents < 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (totalCents <= 0) {
      setError('Enter a monthly budget greater than zero.');
      return;
    }
    if (overAllocated) {
      setError('Category budgets add up to more than the monthly budget.');
      return;
    }

    // Only categories with a positive amount become budget rows; a blank or 0
    // means "no budget for this category" (the dashboard shows no limit for it).
    const payload: SaveBudget = {
      totalBudgetCents: totalCents,
      allocations: categories
        .map((category) => ({
          categoryId: category.id,
          amountCents: inputToCents(allocations[category.id] ?? ''),
        }))
        .filter((allocation) => allocation.amountCents > 0),
    };

    setSaving(true);
    try {
      await saveBudget(period.year, period.month, payload);
      onSaved();
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save budget.');
      setSaving(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
        aria-label="Edit budget"
      >
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2>Budget · {formatMonth(period.year, period.month)}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {loading ? (
          <p className="muted">Loading budget…</p>
        ) : (
          <>
            <label className="field">
              <span>Monthly budget</span>
              <input
                type="number"
                min="0"
                step="1"
                inputMode="decimal"
                value={total}
                onChange={(event) => setTotal(event.target.value)}
              />
            </label>

            <div className="field">
              <span>Per-category limits (optional)</span>
              <ul className="budget-list">
                {categories.map((category) => (
                  <li className="budget-row" key={category.id}>
                    <span className="budget-cat">
                      <span aria-hidden>{category.icon}</span>
                      {category.name}
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="decimal"
                      aria-label={`${category.name} budget`}
                      placeholder="—"
                      value={allocations[category.id] ?? ''}
                      onChange={(event) =>
                        setAllocations((previous) => ({
                          ...previous,
                          [category.id]: event.target.value,
                        }))
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>

            <p className={`budget-summary ${overAllocated ? 'is-bad' : 'muted'}`}>
              {formatDollars(allocatedCents)} of {formatDollars(totalCents)} assigned
              {overAllocated
                ? ` · ${formatDollars(-leftoverCents)} over`
                : ` · ${formatDollars(leftoverCents)} unassigned`}
            </p>

            {error && <p className="sheet-error" role="alert">{error}</p>}

            <button type="submit" className="primary-button" disabled={saving || overAllocated}>
              {saving ? 'Saving…' : 'Save budget'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
