import { useEffect, useRef, useState } from 'react';
import type { Card, Category, NewCard, NewCategory, NewTransaction } from '../api';
import { formatMonth } from '../format';

type Props = {
  cards: Card[];
  categories: Category[];
  defaultDate: string;
  period: { year: number; month: number };
  onClose: () => void;
  onSubmit: (input: NewTransaction) => Promise<void>;
  onAddCard: (input: NewCard) => Promise<Card>;
  onAddCategory: (input: NewCategory) => Promise<Category>;
};

const CARD_COLORS = ['#1f6fb2', '#63e6a5', '#f2b84b', '#ff786c', '#a988f0', '#4dd0e1'];

// The native date picker opens to the month of its starting value, so we seed it
// with the month the app is currently viewing. If that is the current real-world
// month we start on today's date; for any other month we start on its 1st.
function initialExactDate(period: { year: number; month: number }, today: string): string {
  const monthPrefix = `${period.year}-${String(period.month).padStart(2, '0')}`;
  return today.startsWith(monthPrefix) ? today : `${monthPrefix}-01`;
}

// A compact bottom sheet for fast quick-add, matching the transaction-first design.
export function AddTransactionSheet({
  cards,
  categories,
  defaultDate,
  period,
  onClose,
  onSubmit,
  onAddCard,
  onAddCategory,
}: Props) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(categories[0]?.id ?? null);
  const [cardId, setCardId] = useState<number | null>(cards[0]?.id ?? null);
  // Default to month-only entry: fast to log when the exact day isn't remembered.
  const [useExactDay, setUseExactDay] = useState(false);
  // When the user does want a day, open the picker on the month they're viewing.
  const [date, setDate] = useState(() => initialExactDate(period, defaultDate));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addingCard, setAddingCard] = useState(false);
  const [cardName, setCardName] = useState('');
  const [cardNickname, setCardNickname] = useState('');
  const [cardColor, setCardColor] = useState(CARD_COLORS[0]);
  const [cardError, setCardError] = useState<string | null>(null);
  const [cardSaving, setCardSaving] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [categoryName, setCategoryName] = useState('');
  const [categoryIcon, setCategoryIcon] = useState('💸');
  const [categoryColor, setCategoryColor] = useState(CARD_COLORS[0]);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [categorySaving, setCategorySaving] = useState(false);
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
        ...(useExactDay ? { date } : { period }),
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

  const submitCategory = async () => {
    setCategoryError(null);
    if (!categoryName.trim()) {
      setCategoryError('Give the category a name.');
      return;
    }

    setCategorySaving(true);
    try {
      const category = await onAddCategory({
        name: categoryName.trim(),
        icon: categoryIcon.trim() || undefined,
        color: categoryColor,
      });
      setCategoryId(category.id);
      setAddingCategory(false);
      setCategoryName('');
      setCategoryIcon('💸');
      setCategoryColor(CARD_COLORS[0]);
    } catch (addError) {
      setCategoryError(addError instanceof Error ? addError.message : 'Could not add category.');
    } finally {
      setCategorySaving(false);
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
            <button
              type="button"
              className="chip chip-add"
              onClick={() => setAddingCategory((open) => !open)}
              aria-expanded={addingCategory}
            >
              + Add category
            </button>
          </div>

          {addingCategory && (
            <div className="card-add-form">
              <input
                type="text"
                placeholder="Category name (e.g. Coffee)"
                maxLength={40}
                value={categoryName}
                onChange={(event) => setCategoryName(event.target.value)}
              />
              <input
                type="text"
                placeholder="Icon (emoji)"
                maxLength={8}
                value={categoryIcon}
                onChange={(event) => setCategoryIcon(event.target.value)}
              />
              <div className="swatch-row" role="group" aria-label="Category color">
                {CARD_COLORS.map((color) => (
                  <button
                    type="button"
                    key={color}
                    className={`swatch ${categoryColor === color ? 'swatch-on' : ''}`}
                    style={{ background: color }}
                    aria-label={`Color ${color}`}
                    aria-pressed={categoryColor === color}
                    onClick={() => setCategoryColor(color)}
                  />
                ))}
              </div>
              {categoryError && <p className="sheet-error" role="alert">{categoryError}</p>}
              <div className="card-add-actions">
                <button
                  type="button"
                  className="tx-mini"
                  onClick={() => setAddingCategory(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="tx-mini primary-mini"
                  disabled={categorySaving}
                  onClick={submitCategory}
                >
                  {categorySaving ? 'Adding…' : 'Add category'}
                </button>
              </div>
            </div>
          )}
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
          <span className="field-row">
            <span>Date</span>
            <label className="exact-day-toggle">
              <input
                type="checkbox"
                checked={useExactDay}
                onChange={(event) => setUseExactDay(event.target.checked)}
              />
              <span>Set exact day</span>
            </label>
          </span>
          {useExactDay ? (
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          ) : (
            <p className="muted">Logged to {formatMonth(period.year, period.month)}</p>
          )}
        </label>

        {error && <p className="sheet-error" role="alert">{error}</p>}

        <button type="submit" className="primary-button" disabled={saving}>
          {saving ? 'Saving…' : 'Save transaction'}
        </button>
      </form>
    </div>
  );
}
