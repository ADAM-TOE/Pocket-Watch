import { useEffect, useRef, useState } from 'react';
import type { Card, Category, NewCard, NewTransaction } from '../api';

type Props = {
  cards: Card[];
  categories: Category[];
  defaultDate: string;
  onClose: () => void;
  onSubmit: (input: NewTransaction) => Promise<void>;
  onAddCard: (input: NewCard) => Promise<Card>;
};

const CARD_COLORS = ['#1f6fb2', '#63e6a5', '#f2b84b', '#ff786c', '#a988f0', '#4dd0e1'];

// A compact bottom sheet for fast quick-add, matching the transaction-first design.
export function AddTransactionSheet({
  cards,
  categories,
  defaultDate,
  onClose,
  onSubmit,
  onAddCard,
}: Props) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(categories[0]?.id ?? null);
  const [cardId, setCardId] = useState<number | null>(cards[0]?.id ?? null);
  const [date, setDate] = useState(defaultDate);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addingCard, setAddingCard] = useState(false);
  const [cardName, setCardName] = useState('');
  const [cardNickname, setCardNickname] = useState('');
  const [cardColor, setCardColor] = useState(CARD_COLORS[0]);
  const [cardError, setCardError] = useState<string | null>(null);
  const [cardSaving, setCardSaving] = useState(false);
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

  const submitCard = async () => {
    setCardError(null);
    if (!cardName.trim()) {
      setCardError('Give the card a name.');
      return;
    }

    setCardSaving(true);
    try {
      const card = await onAddCard({
        name: cardName.trim(),
        nickname: cardNickname.trim() || undefined,
        color: cardColor,
      });
      setCardId(card.id);
      setAddingCard(false);
      setCardName('');
      setCardNickname('');
      setCardColor(CARD_COLORS[0]);
    } catch (addError) {
      setCardError(addError instanceof Error ? addError.message : 'Could not add card.');
    } finally {
      setCardSaving(false);
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
            <button
              type="button"
              className="chip chip-add"
              onClick={() => setAddingCard((open) => !open)}
              aria-expanded={addingCard}
            >
              + Add card
            </button>
          </div>

          {addingCard && (
            <div className="card-add-form">
              <input
                type="text"
                placeholder="Card name (e.g. Amex Gold)"
                maxLength={60}
                value={cardName}
                onChange={(event) => setCardName(event.target.value)}
              />
              <input
                type="text"
                placeholder="Nickname (optional)"
                maxLength={40}
                value={cardNickname}
                onChange={(event) => setCardNickname(event.target.value)}
              />
              <div className="swatch-row" role="group" aria-label="Card color">
                {CARD_COLORS.map((color) => (
                  <button
                    type="button"
                    key={color}
                    className={`swatch ${cardColor === color ? 'swatch-on' : ''}`}
                    style={{ background: color }}
                    aria-label={`Color ${color}`}
                    aria-pressed={cardColor === color}
                    onClick={() => setCardColor(color)}
                  />
                ))}
              </div>
              {cardError && <p className="sheet-error" role="alert">{cardError}</p>}
              <div className="card-add-actions">
                <button
                  type="button"
                  className="tx-mini"
                  onClick={() => setAddingCard(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="tx-mini primary-mini"
                  disabled={cardSaving}
                  onClick={submitCard}
                >
                  {cardSaving ? 'Adding…' : 'Add card'}
                </button>
              </div>
            </div>
          )}
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
