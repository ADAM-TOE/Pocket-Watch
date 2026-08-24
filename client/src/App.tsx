import { useEffect, useState } from 'react';
import { MonthStepper } from './components/MonthStepper';

type Health = {
  status: string;
  db: string;
  counts: { cards: number; categories: number; budgets: number };
};

export default function App() {
  const now = new Date();
  const [period, setPeriod] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setError(true));
  }, []);

  const statusClass = error ? 'status-bad' : health ? 'status-ok' : 'status-wait';
  const statusText = error ? 'Disconnected' : health ? 'Connected' : 'Connecting…';

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">$</span>
          <h1>Where&apos;s My Money?</h1>
        </div>
        <MonthStepper
          year={period.year}
          month={period.month}
          onChange={(year, month) => setPeriod({ year, month })}
        />
        <div className={`status ${statusClass}`}>
          <span className="status-dot" />
          {statusText}
        </div>
      </header>

      <main className="dashboard">
        <div className="empty-state">
          <p className="empty-title">Dashboard coming next</p>
          <p className="empty-sub">
            Bucket 1 is running. Your spending breakdown chart lands in Bucket 3.
          </p>
          {health && (
            <div className="seed-summary">
              <span>{health.counts.cards} cards</span>
              <span>{health.counts.categories} categories</span>
              <span>{health.counts.budgets} budget</span>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
