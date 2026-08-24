type Props = {
  year: number;
  month: number;
  onChange: (year: number, month: number) => void;
};

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function MonthStepper({ year, month, onChange }: Props) {
  const step = (delta: number) => {
    const zeroBased = month - 1 + delta;
    const newYear = year + Math.floor(zeroBased / 12);
    const newMonth = (((zeroBased % 12) + 12) % 12) + 1;
    onChange(newYear, newMonth);
  };

  return (
    <div className="month-stepper">
      <button type="button" aria-label="Previous month" onClick={() => step(-1)}>
        ‹
      </button>
      <span className="month-label">
        {MONTHS[month - 1]} {year}
      </span>
      <button type="button" aria-label="Next month" onClick={() => step(1)}>
        ›
      </button>
    </div>
  );
}
