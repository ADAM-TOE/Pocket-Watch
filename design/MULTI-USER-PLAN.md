# Multi-User Login — Design & Migration Plan

Status: **DESIGN ONLY.** No code in this plan has been built yet. This is the
ready-to-execute blueprint for the multi-user login phase. Building it requires
sign-off (CLAUDE.md §11) and each bucket below must pass its verification before
the next begins (CLAUDE.md §8).

## 1. Scope and boundary

- Goal: multiple people, each with a private login and **completely separate**
  cards, transactions, budgets, and insights. No shared data between users.
- Still in scope of the north star: each user answers "where did my money go this
  month, and how does each category compare to last month?" — just isolated per user.
- Explicitly NOT in this phase: password reset emails, social login, roles/admin,
  sharing/household accounts, receipt uploads. (Blob storage remains unneeded —
  users are rows, not files.)

## 2. The core risk this design must eliminate

Multi-user is a **security boundary**, not just a feature. The single worst bug
is a query that forgets its owner filter and returns another user's money. The
whole design below is built to make that mistake structurally hard, not to rely
on remembering it on every query.

## 3. Data model changes

### New table

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Owner column added to every per-user table

Add `user_id INTEGER NOT NULL REFERENCES users(id)` to:

| Table | Why it becomes per-user |
|-------|-------------------------|
| `cards` | each person has their own cards (Phase 3 already lets them add cards) |
| `transactions` | the ledger is personal |
| `budgets` | each person sets their own monthly/category budgets |
| `insight_cache` | insights are computed from one person's data |

### Categories: keep global (recommended, confirm before building)

`categories` is a fixed, curated taxonomy (Groceries, Dining, …) and the app does
not support custom user categories today. Keeping it a shared lookup table avoids
per-user seeding of 12 rows each and keeps the category list stable. **Decision to
confirm:** shared categories vs. per-user categories. If per-user custom categories
are ever wanted, this must be revisited — it is the one reversible-later choice here.

### Index changes

The budget uniqueness guard must include the owner:

```sql
-- replaces idx_budget_period_cat
CREATE UNIQUE INDEX idx_budget_user_period_cat
  ON budgets(user_id, year, month, IFNULL(category_id, 0));
CREATE INDEX idx_tx_user_date ON transactions(user_id, date);
```

## 4. Migration (your existing data becomes user #1)

Run inside one transaction in `initSchema` / a migration step in `db.ts`:

1. Create the `users` table.
2. If `users` is empty **and** existing cards/transactions/budgets exist, create a
   single bootstrap user (email from an env var, e.g. `BOOTSTRAP_USER_EMAIL`, with
   a hash the user sets on first login — or a placeholder that forces a password set).
3. Add the `user_id` column to each per-user table (SQLite: add column, backfill
   with the bootstrap user id, then enforce NOT NULL via table rebuild — the same
   `_v2` table-rebuild pattern already used in `migrateLegacyMoneyColumns`).
4. Rebuild indexes.

Correct means: after migration, all current transactions/budgets/cards belong to
user #1, totals are unchanged, and the app behaves exactly as before for that user.

## 5. Authentication

- **Password hashing:** `argon2` (preferred) or `bcrypt`. Never store plaintext.
  Decision to confirm: argon2id vs bcrypt.
- **Sessions:** signed, `HttpOnly`, `SameSite=Lax`, `Secure` (in production) cookie
  holding a session id or a signed token. Server holds a `SESSION_SECRET` env var
  (server-side only, gitignored — CLAUDE.md §3). Decision to confirm: server-side
  session store table vs. stateless signed JWT. Recommendation: a `sessions` table
  (or signed cookie with rotation) — simplest to revoke on logout.
- **CSRF:** because auth rides on a cookie, add CSRF protection (double-submit token
  or `SameSite=Lax` + custom header check on mutations).

## 6. Data isolation pattern (the safety mechanism)

- Add auth middleware that reads the cookie, verifies it, and sets `req.userId`.
- Mount it in front of every `/api` router except `/api/auth/*` and `/api/health`.
- Change every data query to require the owner. The pattern that makes forgetting
  hard: pass `userId` into each router factory and each SQL statement includes
  `WHERE user_id = ?`. Writes always set `user_id = ?` from `req.userId`, never
  from the request body.
- Reference/dashboard/insights/budgets/transactions queries all gain the filter.

## 7. Per-user seeding on registration

On successful `register`, seed that user's starting data in one transaction:
the four preloaded cards and a default $2,000 total monthly budget for the current
month (mirrors `seed.ts`, but scoped to the new `user_id`). Categories are shared,
so nothing to seed there under the recommended model.

## 8. API surface

New:
- `POST /api/auth/register` → creates user, seeds their data, starts a session.
- `POST /api/auth/login` → verifies password, starts a session.
- `POST /api/auth/logout` → ends the session.
- `GET  /api/auth/me` → returns the current user or 401.

Existing routers (`reference`, `transactions`, `dashboard`, `budgets`, `insights`)
become auth-protected and owner-scoped.

## 9. Frontend

- An auth context that calls `GET /api/auth/me` on load.
- A login/register screen shown when unauthenticated; the dashboard is gated behind it.
- A logout control in the header.
- All existing `fetch` calls already share a cookie automatically; add
  `credentials: 'include'` if the client is served from a different origin in dev.

## 10. Verification plan (must run before sign-off)

1. **Isolation test (most important):** create user A and user B; A's transactions,
   cards, budgets, and dashboard never include any of B's data, and B cannot read,
   edit, or delete A's rows by id (expect 404/403, never data).
2. **Auth-required test:** every `/api` data route returns 401 without a session.
3. **Migration test:** seed a pre-auth database, run the migration, assert all rows
   now belong to user #1 and monthly totals are unchanged.
4. **Password test:** wrong password fails; stored value is a hash, never plaintext.
5. **Session lifecycle:** login sets a cookie, logout invalidates it, `/me` reflects state.

## 11. Delivery buckets (build order)

1. Users table + auth endpoints + hashing + sessions (no isolation yet, tested).
2. Migration to user #1 (tested: totals unchanged).
3. Owner column + auth middleware + owner-scoped queries across all routers
   (tested: isolation + auth-required).
4. Per-user seeding on register (tested).
5. Frontend auth gate, login/register screen, logout.
6. Deploy considerations: `SESSION_SECRET` in App Service config; cookies `Secure`
   behind HTTPS; SQLite still single-instance (unchanged constraint).

## 12. Decisions to confirm before building

- Categories shared/global (recommended) vs. per-user.
- Password hashing: argon2id (recommended) vs. bcrypt.
- Sessions: server-side `sessions` table (recommended) vs. stateless signed JWT.
- Bootstrap user #1: fixed email via env + forced first-login password set.
