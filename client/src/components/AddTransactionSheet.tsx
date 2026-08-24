import { useEffect, useRef, useState } from 'react';
import type { Card, Category, NewTransaction } from '../api';

type Props = {
  cards: Card[];
  categories: Category[];
  defaultDate: string;
  onClose: () => void;
  onSubmit: (input: NewTransaction) => Promise<void>;
};

// A compact bottom sheet for fast quick-add, matching the transaction-first design.
export function AddTransactionSheet({ cards, categories, defaultDate, onClose, onSubmit }: Props) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(categories[0]?.id ?? null);
  const [cardId, setCardId] = useState<number | null>(cards[0]?.id ?? null);
  const [date, setDate] = useState(defaultDate);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    amountRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    if (categoryId === null || cardId === null) {
      setError('Pick a category and a card.');
      return;
    }

    setSaving(true);
    try {
      await onSubmit({
        amountCents: Math.round(dollars * 100),
        description: description.trim(),
        categoryId,
        cardId,
        date,
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not save transaction.');
      setSaving(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
        aria-label="Add transaction"
      >
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2>Add transaction</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <label className="field">
          <span>Amount</span>
          <input
            ref={amountRef}
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>

        <label className="field">
          <span>Description</span>
          <input
            type="text"
            placeholder="e.g. Trader Joe's"
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
          {saving ? 'Saving…' : 'Save transaction'}
        </button>
      </form>
    </div>
  );
}
