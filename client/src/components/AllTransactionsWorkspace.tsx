import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTransactions, type Transaction } from '../api';
import { formatCents, formatShortDate } from '../format';

const PAGE_SIZE = 50;

// A large scrollable workspace for browsing every past transaction, newest first.
export function AllTransactionsWorkspace({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Transaction[]>([]);
  const [offset, setOffset] = useState(0);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const loadMore = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTransactions(PAGE_SIZE, offset);
      setRows((previous) => [...previous, ...result.transactions]);
      setOffset((previous) => previous + result.transactions.length);
      if (result.transactions.length < PAGE_SIZE) setDone(true);
    } catch {
      setError('Could not load transactions.');
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    loadMore();
  }, [loadMore]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="workspace-backdrop" onClick={onClose}>
      <section
        className="workspace"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="All transactions"
      >
        <div className="workspace-head">
          <h2>All transactions</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="workspace-body">
          {rows.length === 0 && !loading && !error && (
            <p className="muted">No transactions yet.</p>
          )}

          <ul className="tx-list">
            {rows.map((tx) => (
              <li className="tx-row" key={tx.id}>
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

          {error && <p className="sheet-error" role="alert">{error}</p>}

          <div className="workspace-foot">
            {done ? (
              rows.length > 0 && <span className="muted">You&apos;re all caught up.</span>
            ) : (
              <button type="button" className="load-more" onClick={loadMore} disabled={loading}>
                {loading ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
