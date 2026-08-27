import { useCallback, useEffect, useState } from 'react';
import { MonthStepper } from './components/MonthStepper';
import { AddTransactionSheet } from './components/AddTransactionSheet';
import { AllTransactionsWorkspace } from './components/AllTransactionsWorkspace';
import {
  createCard,
  createTransaction,
  fetchDashboard,
  fetchInsights,
  fetchReference,
  type DashboardSummary,
  type Insight,
  type NewCard,
  type NewTransaction,
  type Reference,
} from './api';
import {
  formatCents,
  formatDollars,
  formatMonth,
  formatShare,
  formatShortDate,
  formatSignedDollars,
} from './format';

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export default function App() {
  const now = new Date();
  const [period, setPeriod] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [reference, setReference] = useState<Reference | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const loadPeriod = useCallback(async (year: number, month: number) => {
    setLoadError(false);
    try {
      const [dashboard, insightResult] = await Promise.all([
        fetchDashboard(year, month),
        fetchInsights(year, month),
      ]);
      setSummary(dashboard);
      setInsights(insightResult.insights);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    fetchReference().then(setReference).catch(() => setReference({ cards: [], categories: [] }));
  }, []);

  useEffect(() => {
    loadPeriod(period.year, period.month);
  }, [period, loadPeriod]);

  const handleAdd = async (input: NewTransaction) => {
    await createTransaction(input);
    setSheetOpen(false);
    await loadPeriod(period.year, period.month);
  };

  const handleAddCard = async (input: NewCard) => {
    const card = await createCard(input);
    setReference((previous) =>
      previous ? { ...previous, cards: [...previous.cards, card] } : previous,
    );
    return card;
  };

  const totals = summary?.totals;
  const remainingCents = totals?.remainingCents ?? null;
  const overspent = remainingCents !== null && remainingCents < 0;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">$</span>
          <div>
            <h1>Pocket Watch</h1>
            <span className="brand-kicker">Monthly spending ledger</span>
          </div>
        </div>
        <MonthStepper
          year={period.year}
          month={period.month}
          onChange={(year, month) => setPeriod({ year, month })}
        />
      </header>

      {insights.length > 0 && (
        <div className="ticker" role="status">
          <span className="ticker-label">Insights</span>
          <div className="ticker-track">
            {insights.map((insight) => (
              <span className="ticker-item" key={insight.id}>{insight.text}</span>
            ))}
          </div>
        </div>
      )}

      <main className="dashboard">
        {loadError && (
          <div className="panel error-panel">
            <p>Couldn&apos;t reach the server. Is it running?</p>
          </div>
        )}

        {!loadError && !summary && (
          <div className="panel">Loading {formatMonth(period.year, period.month)}…</div>
        )}

        {summary && (
          <>
            <section className="status-bar" aria-label="Monthly summary">
              <div className="status-cell">
                <span className="status-label">Spent this month</span>
                <span className="status-value">{formatDollars(summary.totals.spentCents)}</span>
              </div>
              <div className="status-cell">
                <span className="status-label">{overspent ? 'Over budget' : 'Remaining'}</span>
                <span className={`status-value ${overspent ? 'is-bad' : 'is-good'}`}>
                  {remainingCents === null ? '—' : formatDollars(Math.abs(remainingCents))}
                </span>
              </div>
              <div className="status-cell">
                <span className="status-label">Compared with last month</span>
                <span
                  className={`status-value ${
                    summary.totals.deltaCents > 0
                      ? 'is-bad'
                      : summary.totals.deltaCents < 0
                        ? 'is-good'
                        : ''
                  }`}
                >
                  {formatSignedDollars(summary.totals.deltaCents)}
                </span>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2 className="panel-title">Recent transactions</h2>
                <button type="button" className="link-button" onClick={() => setAllOpen(true)}>
                  View all →
                </button>
              </div>
              {summary.recentTransactions.length === 0 ? (
                <p className="muted">Nothing logged yet. Tap “Add transaction” to start.</p>
              ) : (
                <ul className="tx-list">
                  {summary.recentTransactions.map((tx) => (
                    <li className="tx-row" key={tx.id}>
                      <span
                        className="tx-swatch"
                        style={{ background: tx.categoryColor }}
                        aria-hidden
                      />
                      <span className="tx-main">
                        <span className="tx-desc">{tx.description}</span>
                        <span className="tx-meta">
                          {tx.categoryName} · {tx.cardName} · {formatShortDate(tx.date)}
                        </span>
                      </span>
                      <span className="tx-amount">{formatCents(tx.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel">
              <h2 className="panel-title">Where your money went</h2>
              {summary.categories.length === 0 ? (
                <p className="muted">No spending recorded yet this month.</p>
              ) : (
                <ul className="category-list">
                  {summary.categories.map((category) => (
                    <li className="category-row" key={category.categoryId}>
                      <span className="category-name">
                        <span
                          className="category-swatch"
                          style={{ background: category.color }}
                          aria-hidden
                        />
                        {category.name}
                      </span>
                      <div className="category-bar">
                        <div
                          className="category-bar-fill"
                          style={{
                            width: `${Math.max(3, category.shareBasisPoints / 100)}%`,
                            background: category.color,
                          }}
                        />
                      </div>
                      <span className="category-share">
                        {formatShare(category.shareBasisPoints)}
                      </span>
                      <span className="category-amount">
                        {formatDollars(category.spentCents)}
                      </span>
                      <span
                        className={`category-delta ${
                          category.deltaCents > 0
                            ? 'is-bad'
                            : category.deltaCents < 0
                              ? 'is-good'
                              : 'muted'
                        }`}
                      >
                        {category.deltaCents === 0
                          ? '—'
                          : formatSignedDollars(category.deltaCents)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>

      <button
        type="button"
        className="fab"
        onClick={() => setSheetOpen(true)}
        disabled={!reference || reference.cards.length === 0}
      >
        + Add transaction
      </button>

      {sheetOpen && reference && (
        <AddTransactionSheet
          cards={reference.cards}
          categories={reference.categories}
          defaultDate={todayIso()}
          onClose={() => setSheetOpen(false)}
          onSubmit={handleAdd}
          onAddCard={handleAddCard}
        />
      )}

      {allOpen && reference && (
        <AllTransactionsWorkspace
          cards={reference.cards}
          categories={reference.categories}
          onClose={() => setAllOpen(false)}
          onChanged={() => loadPeriod(period.year, period.month)}
        />
      )}
    </div>
  );
}
