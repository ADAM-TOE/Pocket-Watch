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
- **Login model (confirmed):** a **password is the base credential**, and a
  **passkey (WebAuthn / Face ID) is an optional, faster second way to log in** to
  the same account. Learn classic auth first, add passkeys as an enhancement — the
  password is always the fallback so device loss never locks you out completely.
- **Registration (confirmed):** **no public signup.** There is no open
  `register` endpoint on the internet. Accounts are created by the operator (you)
  via a seeding script / admin-only path. This removes an abuse and cost vector on
  the public Azure server.
- **Recovery (confirmed):** **one-time recovery codes** generated at account
  setup, shown once, stored offline by the user. They let you regain access if the
  password is forgotten and all passkey devices are lost — without building reset
  emails.
- Explicitly NOT in this phase: password reset **emails**, social login,
  roles/admin, sharing/household accounts, receipt uploads. (Blob storage remains
  unneeded — users are rows, not files.)

## 2. The core risk this design must eliminate

Multi-user is a **security boundary**, not just a feature. The single worst bug
is a query that forgets its owner filter and returns another user's money. The
whole design below is built to make that mistake structurally hard, not to rely
on remembering it on every query.

**Confirmed enforcement style:** a **single data-access layer** is the only place
that builds SQL. Every statement is created in one module that always injects
`user_id`, so no route can accidentally skip the owner filter. This is the
**choke-point pattern** — make the safe path the *only* path, rather than trusting
review to catch a missing `WHERE user_id = ?`.

## 3. Data model changes

### New tables

```sql
-- Accounts. password_hash is nullable so a freshly created (or migrated)
-- account can be forced to SET a password before any data route works,
-- instead of shipping a guessable placeholder hash (that would be a backdoor).
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,                         -- argon2id; NULL = must set on first login
  must_set_pw   INTEGER NOT NULL DEFAULT 0,   -- 1 forces a set-password step
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Server-side sessions so we can revoke instantly (a JWT cannot be un-issued).
-- We store a HASH of the session id, never the raw value — same reasoning as
-- passwords: a DB leak must not hand out live sessions.
CREATE TABLE sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  token_hash     TEXT NOT NULL UNIQUE,        -- sha256 of the random cookie value
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT NOT NULL                -- absolute timeout; idle timeout via last_seen_at
);

-- WebAuthn / passkey credentials. Stores only the PUBLIC key — useless if stolen.
-- The private key never leaves the phone's secure hardware; Face ID only unlocks
-- it locally. sign_count is checked to detect cloned authenticators.
CREATE TABLE webauthn_credentials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  credential_id  TEXT NOT NULL UNIQUE,        -- base64url id from the authenticator
  public_key     BLOB NOT NULL,
  sign_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time recovery codes, stored HASHED. Each row is consumed on use.
CREATE TABLE recovery_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  code_hash   TEXT NOT NULL,
  used_at     TEXT                            -- NULL = unused
);

-- Brute-force / throttling ledger: recent login attempts per email + IP.
CREATE TABLE login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT,
  ip          TEXT,
  succeeded   INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_attempts_email_time ON login_attempts(email, created_at);
```

### Foreign keys must be enabled

SQLite ignores `REFERENCES` unless you run `PRAGMA foreign_keys = ON` **on every
connection**. Without it the `user_id REFERENCES users(id)` constraints are
decorative and orphaned rows are possible. Confirm this pragma is set where the
DB connection is opened in `db.ts`.

## 4. Migration (your existing data becomes user #1)

Run inside one transaction in `initSchema` / a migration step in `db.ts`:

1. Create the `users`, `sessions`, `webauthn_credentials`, `recovery_codes`, and
   `login_attempts` tables.
2. If `users` is empty **and** existing cards/transactions/budgets exist, create a
   single bootstrap user (email from `BOOTSTRAP_USER_EMAIL`) with
   `password_hash = NULL` and `must_set_pw = 1`. **No placeholder hash** — a known
   placeholder is a backdoor. Login is blocked until the set-password step runs, so
   there is no window where a guessable credential works.
3. Add the `user_id` column to each per-user table (SQLite: add column, backfill
   with the bootstrap user id, then enforce NOT NULL via table rebuild — the same
   `_v2` table-rebuild pattern already used in `migrateLegacyMoneyColumns`).
4. Rebuild indexes.

Correct means: after migration, all current transactions/budgets/cards belong to
user #1, totals are unchanged, and the app behaves exactly as before for that user.

## 5. Authentication

- **Password hashing (confirmed argon2id):** memory-hard hashing so a stolen DB is
  expensive to crack. Never store plaintext. Pick sane cost parameters and keep
  them in one place so they can be raised later.
- **Sessions (confirmed server-side `sessions` table):** a `HttpOnly`,
  `SameSite=Lax`, `Secure` (in production) cookie carries a **random** session id;
  the DB stores only its **hash**. Chosen over stateless JWT because it can be
  revoked instantly on logout. Consider the `__Host-` cookie prefix in production.
- **Session hardening (the three classic session bugs, designed out):**
  - **Fixation:** issue a brand-new session id **at login** (rotate on privilege
    change); never reuse a pre-login id.
  - **Theft-via-DB:** store `sha256(token)`, not the raw token (see §3).
  - **No expiry:** enforce both an **idle timeout** (`last_seen_at`) and an
    **absolute timeout** (`expires_at`); check both on every request.
- **Randomness:** session ids, CSRF tokens, and recovery codes come from a
  **CSPRNG** (`crypto.randomBytes`), never `Math.random()`.
- **Brute-force protection:** rate-limit `/api/auth/login` per IP **and** per
  email, with backoff/lockout after repeated failures (via `login_attempts`).
- **No user enumeration / timing leaks:** one generic "invalid email or password"
  message for both cases; **always run an argon2 verify even when the email is
  unknown** so response time is uniform; use constant-time comparison.
- **Password policy:** enforce a **minimum length** (length beats complexity
  rules) and check candidates against the **breached-password** list via the
  HaveIBeenPwned k-anonymity range API (only a hash prefix leaves the server).
- **Passkeys (WebAuthn) as a second login option:**
  - Concept: **public-key cryptography**. The phone keeps a **private key** in
    secure hardware; the server stores only the **public key**. Login = server
    sends a random **challenge**, device signs it (Face ID unlocks the key
    locally), server verifies the signature. No secret is ever transmitted or
    stored server-side.
  - Store per-credential `sign_count` and reject a login where the counter goes
    backwards (clone detection).
  - The random challenge is single-use and short-lived; bind it to the session.
- **CSRF:** because auth rides on a cookie, add CSRF protection (double-submit
  token from the CSPRNG, or `SameSite=Lax` + a required custom header on
  mutations).

## 6. Data isolation pattern (the safety mechanism)

- Add auth middleware that reads the cookie, verifies the session (exists, not
  expired), refreshes `last_seen_at`, and sets `req.userId`.
- Mount it in front of every `/api` router except `/api/auth/*` and `/api/health`.
- **Choke-point (confirmed):** all SQL is built in a **single data-access layer**
  that takes `userId` and injects `WHERE user_id = ?` into every read and
  `user_id = ?` into every write. Routes never write raw SQL, so a route
  *cannot* forget the owner filter. `user_id` always comes from `req.userId`,
  **never** from the request body.
- **IDOR defense on writes:** every `UPDATE`/`DELETE` by id must include
  `AND user_id = ?`, and the layer asserts **exactly one row changed** — a
  cross-owner attempt changes zero rows and is rejected (404), never silently
  touching someone else's data. ("IDOR" = Insecure Direct Object Reference: acting
  on another user's row by guessing its id.)
- Reference/dashboard/insights/budgets/transactions queries all gain the filter
  through this one layer.
- **Backup / export path (do not miss):** `backup.ts` and any CSV/xlsx export are
  the biggest leak risk — a full-table dump now spans all users. These must go
  through the same owner-scoped layer and export only `req.userId`'s rows.
- **Insights isolation:** the `insight_cache` **cache key must include `user_id`**,
  and the prompt sent to `gpt-5-mini` must contain **only the requesting user's**
  computed figures (ties to CLAUDE.md §4 — the model never crosses users).

## 7. Per-user seeding on account creation

Because there is **no public registration**, accounts are created by the operator
(a seeding/admin script). When an account is created, seed its starting data in one
transaction: the four preloaded cards and a default $2,000 total monthly budget for
the current month (mirrors `seed.ts`, but scoped to the new `user_id`). Also
generate the one-time **recovery codes** at this point, store them hashed, and
display them **once**. Categories are shared, so nothing to seed there under the
recommended model.

## 8. API surface

New (auth):
- `POST /api/auth/login` → rate-limited; verifies password; **rotates** to a new
  session id; sets the cookie.
- `POST /api/auth/logout` → deletes the session row; clears the cookie.
- `GET  /api/auth/me` → returns the current user or 401.
- `POST /api/auth/set-password` → completes the forced first-login password set
  for a `must_set_pw` account; clears the flag.
- `POST /api/auth/recover` → consumes a valid one-time recovery code, lets the
  user set a new password, invalidates that code.

New (passkeys / WebAuthn):
- `POST /api/auth/webauthn/register/options` and `.../register/verify` →
  enroll a passkey for the **already-logged-in** user (public key stored).
- `POST /api/auth/webauthn/login/options` and `.../login/verify` →
  challenge/response passkey login that starts a session.

**No `POST /api/auth/register` on the public server** — account creation is an
operator-only script/path (§1, §7).

Existing routers (`reference`, `transactions`, `dashboard`, `budgets`, `insights`,
and the backup/export path) become auth-protected and owner-scoped via the §6
data-access layer.

## 9. Frontend

- An auth context that calls `GET /api/auth/me` on load.
- A login/register screen shown when unauthenticated; the dashboard is gated behind it.
- A logout control in the header.
- All existing `fetch` calls already share a cookie automatically; add
  `credentials: 'include'` if the client is served from a different origin in dev.

## 10. Verification plan (must run before sign-off)

1. **Isolation test (most important):** create user A and user B; A's transactions,
   cards, budgets, dashboard, insights, **and backup/export** never include any of
   B's data, and B cannot read, edit, or delete A's rows by id (expect 404/403,
   never data). Include an `UPDATE`/`DELETE`-by-id cross-owner attempt (IDOR).
2. **Auth-required test:** every `/api` data route returns 401 without a session.
3. **Migration test:** seed a pre-auth database, run the migration, assert all rows
   now belong to user #1, monthly totals are unchanged, and the account is in
   `must_set_pw` state (no usable hash).
4. **Password test:** wrong password fails; stored value is an argon2id hash, never
   plaintext; too-short and known-breached passwords are rejected.
5. **Enumeration/timing test:** unknown email and wrong password return the same
   message and similar timing (a verify runs even for unknown emails).
6. **Brute-force test:** repeated failed logins get throttled/locked.
7. **Session lifecycle:** login rotates the id and sets a cookie; the DB holds only
   a hash; logout invalidates it; expired sessions are rejected; `/me` reflects
   state.
8. **Passkey test:** enroll a passkey while logged in, then log in with it; a
   backwards `sign_count` is rejected; the challenge is single-use.
9. **Recovery test:** a valid recovery code lets you reset the password and is then
   unusable; an already-used or unknown code fails.
10. **CSRF test:** a state-changing request without the token/custom header is
    rejected.

## 11. Delivery buckets (build order)

1. Users + sessions tables, argon2id hashing, login/logout/me, session hardening
   (rotate on login, hashed token, expiry), CSPRNG, rate limiting, and
   enumeration/timing defense (no isolation yet, tested).
2. Migration to user #1 with `must_set_pw` + set-password flow (tested: totals
   unchanged, no usable placeholder hash).
3. Owner column + `PRAGMA foreign_keys = ON` + auth middleware + the single
   **data-access layer** injecting `user_id` across all routers **and the
   backup/export path**; IDOR-safe writes (tested: isolation + auth-required).
4. Operator-only account creation + per-user seeding + one-time recovery codes
   (tested).
5. Frontend auth gate, login screen, set-password + recovery screens, logout.
6. Passkeys (WebAuthn): enroll-while-logged-in + passkey login, `sign_count`
   clone check (tested).
7. Deploy considerations: `SESSION_SECRET` in App Service config; cookies `Secure`
   + HSTS behind HTTPS; correct WebAuthn **relying-party id / origin** for the
   deployed domain; SQLite still single-instance (unchanged constraint).

## 12. Decisions — resolved

- **Login model:** password base credential **+ passkey as an optional second
  login** (confirmed).
- **Registration:** **no public signup**; operator-created accounts (confirmed).
- **Recovery:** **one-time recovery codes** stored offline (confirmed).
- **Isolation enforcement:** **single data-access layer** choke-point (confirmed).
- **Password hashing:** **argon2id** (confirmed).
- **Sessions:** **server-side `sessions` table**, hashed token, rotate on login
  (confirmed).
- **Bootstrap user #1:** fixed email via env + `must_set_pw` (no placeholder hash)
  (confirmed).
- **Learning depth:** **deep** — implement each piece by hand and understand it
  before leaning on a vetted library (confirmed).
- **Categories:** **shared/global** lookup table, not per-user (confirmed 2026-09-03).

All blocking decisions are resolved; Bucket 3 is cleared to build.
