import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteTransaction,
  fetchTransactions,
  updateTransaction,
  type Card,
  type Category,
  type Transaction,
} from '../api';
import { formatCents, formatShortDate } from '../format';

const PAGE_SIZE = 50;

type Props = {
  cards: Card[];
  categories: Category[];
  onClose: () => void;
  onChanged: () => void;
};

// A large scrollable workspace for browsing, editing, and deleting past transactions.
export function AllTransactionsWorkspace({ cards, categories, onClose, onChanged }: Props) {
  const [rows, setRows] = useState<Transaction[]>([]);
  const [offset, setOffset] = useState(0);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
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
      if (event.key === 'Escape' && !editing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  const handleSaved = (updated: Transaction) => {
    setRows((previous) => previous.map((row) => (row.id === updated.id ? updated : row)));
    setEditing(null);
    onChanged();
  };

  const handleDelete = async (id: number) => {
    setBusyId(id);
    setError(null);
    try {
      await deleteTransaction(id);
      setRows((previous) => previous.filter((row) => row.id !== id));
      setConfirmingId(null);
      onChanged();
    } catch {
      setError('Could not delete that transaction.');
    } finally {
      setBusyId(null);
    }
  };

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
              <li className="tx-row tx-row-editable" key={tx.id}>
                <span className="tx-main">
                  <span className="tx-desc">{tx.description}</span>
                  <span className="tx-meta">
                    {tx.categoryName} · {tx.cardName} · {formatShortDate(tx.date)}
                  </span>
                </span>
                <span className="tx-amount">{formatCents(tx.amountCents)}</span>
                {confirmingId === tx.id ? (
                  <span className="tx-row-actions">
                    <button
                      type="button"
                      className="tx-mini danger"
                      disabled={busyId === tx.id}
                      onClick={() => handleDelete(tx.id)}
                    >
                      {busyId === tx.id ? 'Deleting…' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      className="tx-mini"
                      onClick={() => setConfirmingId(null)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <span className="tx-row-actions">
                    <button
                      type="button"
                      className="tx-mini"
                      onClick={() => setEditing(tx)}
                      aria-label={`Edit ${tx.description}`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="tx-mini danger"
                      onClick={() => setConfirmingId(tx.id)}
                      aria-label={`Delete ${tx.description}`}
                    >
                      Delete
                    </button>
                  </span>
                )}
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

        <div className="workspace-actions">
          <button type="button" className="close-wide" onClick={onClose}>
            Close
          </button>
        </div>
      </section>

      {editing && (
        <EditTransactionDialog
          transaction={editing}
          cards={cards}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
type EditProps = {
  transaction: Transaction;
  cards: Card[];
  categories: Category[];
  onClose: () => void;
  onSaved: (updated: Transaction) => void;
};

// A nested dialog for editing one transaction without leaving the list.
function EditTransactionDialog({ transaction, cards, categories, onClose, onSaved }: EditProps) {
  const [amount, setAmount] = useState((transaction.amountCents / 100).toFixed(2));
  const [description, setDescription] = useState(transaction.description);
  const [categoryId, setCategoryId] = useState(transaction.categoryId);
  const [cardId, setCardId] = useState(transaction.cardId);
  const [date, setDate] = useState(transaction.date);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (!description.trim()) {
      setError('Add a short description.');
      return;
    }

    setSaving(true);
    try {
      const updated = await updateTransaction(transaction.id, {
        amountCents: Math.round(dollars * 100),
        description: description.trim(),
        categoryId,
        cardId,
        date,
      });
      onSaved(updated);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not update transaction.');
      setSaving(false);
    }
  };

  return (
    <div className="sheet-backdrop nested" onClick={onClose}>
      <form
        className="sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
        aria-label="Edit transaction"
      >
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2>Edit transaction</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <label className="field">
          <span>Amount</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>

        <label className="field">
          <span>Description</span>
          <input
            type="text"
            maxLength={200}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <div className="field">
          <span>Category</span>
          <div className="chip-row">
            {categories.map((category) => (
              <button
                type="button"
                key={category.id}
                className={`chip ${categoryId === category.id ? 'chip-on' : ''}`}
                onClick={() => setCategoryId(category.id)}
              >
                <span aria-hidden>{category.icon}</span>
                {category.name}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Card</span>
          <div className="chip-row">
            {cards.map((card) => (
              <button
                type="button"
                key={card.id}
                className={`chip ${cardId === card.id ? 'chip-on' : ''}`}
                onClick={() => setCardId(card.id)}
              >
                <span className="chip-dot" style={{ background: card.color }} aria-hidden />
                {card.nickname ?? card.name}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span>Date</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>

        {error && <p className="sheet-error" role="alert">{error}</p>}

        <button type="submit" className="primary-button" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </div>
  );
}

