import { formatCents, formatShare } from '../format';

type Slice = {
  categoryId: number;
  name: string;
  color: string;
  spentCents: number;
  shareBasisPoints: number;
  length: number;
  offset: number;
};

type Props = {
  categories: Array<{
    categoryId: number;
    name: string;
    color: string;
    spentCents: number;
    shareBasisPoints: number;
  }>;
  totalCents: number;
};

const RADIUS = 42;
const STROKE = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Pure helper: turn categories into arcs sized by share, each starting where the previous ended.
export function buildSlices(categories: Props['categories']): Slice[] {
  let offset = 0;
  return categories.map((category) => {
    const share = category.shareBasisPoints / 10000;
    const length = share * CIRCUMFERENCE;
    const slice: Slice = { ...category, length, offset };
    offset += length;
    return slice;
  });
}

// A dependency-free donut: one stroked circle per category, painted with stroke-dasharray.
export function CategoryDonut({ categories, totalCents }: Props) {
  if (categories.length === 0) return null;

  const slices = buildSlices(categories);

  return (
    <div className="donut">
      <svg
        className="donut-svg"
        viewBox="0 0 120 120"
        role="img"
        aria-label={`Spending by category, ${formatCents(totalCents)} total`}
      >
        <g transform="rotate(-90 60 60)">
          <circle
            className="donut-track"
            cx="60"
            cy="60"
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
          />
          {slices.map((slice) => (
            <circle
              key={slice.categoryId}
              className="donut-slice"
              cx="60"
              cy="60"
              r={RADIUS}
              fill="none"
              stroke={slice.color}
              strokeWidth={STROKE}
              strokeDasharray={`${slice.length} ${CIRCUMFERENCE - slice.length}`}
              strokeDashoffset={-slice.offset}
            >
              <title>
                {slice.name}: {formatCents(slice.spentCents)} ({formatShare(slice.shareBasisPoints)})
              </title>
            </circle>
          ))}
        </g>
      </svg>
      <div className="donut-center" aria-hidden>
        <span className="donut-total">{formatCents(totalCents)}</span>
        <span className="donut-caption">spent</span>
      </div>
    </div>
  );
}
