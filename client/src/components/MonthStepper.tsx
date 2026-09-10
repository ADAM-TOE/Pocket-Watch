import { useEffect, useRef, useState } from 'react';

type Props = {
  year: number;
  month: number;
  onChange: (year: number, month: number) => void;
};

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function MonthStepper({ year, month, onChange }: Props) {
  // UI state: is the picker popover open? (App owns the selected month.)
  const [open, setOpen] = useState(false);
  // The year the grid is showing. You can page through years with the picker's
  // own ‹ › without committing until you tap a month, so it's separate state.
  const [viewYear, setViewYear] = useState(year);
  // A stable handle to the wrapper so we can tell inside vs. outside clicks.
  const containerRef = useRef<HTMLDivElement>(null);

  const step = (delta: number) => {
    const zeroBased = month - 1 + delta;
    const newYear = year + Math.floor(zeroBased / 12);
    const newMonth = (((zeroBased % 12) + 12) % 12) + 1;
    onChange(newYear, newMonth);
  };

  const toggle = () => {
    setViewYear(year); // always reopen on the currently selected year
    setOpen((wasOpen) => !wasOpen);
  };

  const pick = (pickedMonth: number) => {
    onChange(viewYear, pickedMonth);
    setOpen(false);
  };

  // While open, close on an outside tap or the Escape key. pointerdown covers
  // mouse, touch, and pen with one event. The returned function is React's
  // cleanup: it removes the listeners when we close or unmount.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="month-stepper" ref={containerRef}>
      <button type="button" aria-label="Previous month" onClick={() => step(-1)}>
        ‹
      </button>
      <button
        type="button"
        className="month-label"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        {MONTHS[month - 1]} {year}
      </button>
      <button type="button" aria-label="Next month" onClick={() => step(1)}>
        ›
      </button>

      {open && (
        <div className="month-picker" role="dialog" aria-label="Choose month">
          <div className="month-picker-head">
            <button
              type="button"
              aria-label="Previous year"
              onClick={() => setViewYear((y) => y - 1)}
            >
              ‹
            </button>
            <span className="month-picker-year">{viewYear}</span>
            <button
              type="button"
              aria-label="Next year"
              onClick={() => setViewYear((y) => y + 1)}
            >
              ›
            </button>
          </div>
          <div className="month-grid">
            {MONTHS_SHORT.map((label, index) => {
              const cellMonth = index + 1;
              const isCurrent = viewYear === year && cellMonth === month;
              return (
                <button
                  key={label}
                  type="button"
                  className={`month-cell${isCurrent ? ' is-current' : ''}`}
                  aria-pressed={isCurrent}
                  aria-label={`${MONTHS[index]} ${viewYear}`}
                  onClick={() => pick(cellMonth)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
