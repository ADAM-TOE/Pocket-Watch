# Pocket Watch Backend Plan

## Product Boundary

Pocket Watch answers two questions:

1. Where did my money go this month?
2. How does each category compare with last month?

The "Can I afford this?" feature, semantic search, embeddings, and vector storage
are out of scope. Transaction search uses deterministic SQL filters.

## Agreed Behavior

- Users can add, edit, and delete transactions. Delete requires confirmation.
- The monthly summary shows spent, budget remaining, and change from the same
  elapsed dates last month.
- Recent transactions show the newest records for the selected month.
- Transaction search covers merchant/description, category, and card.
- Selecting a category in "Where your money went" opens its filtered transactions.
- Category budget allocations must equal the overall monthly budget.
- The first monthly trend is cumulative daily spending compared with the same
  elapsed period last month.
- The dashboard shows up to three concise, neutral insights.
- Each insight exposes its exact supporting figures and opens the contributing
  filtered transactions.
- Invalid AI output is rejected and replaced with a deterministic fallback.

## Architecture Decision

### Live data

SQLite remains the live relational database for v1. Express is the only process
that reads or writes it. Production deployment is limited to one App Service
instance because SQLite cannot coordinate writes safely across scaled instances.

On Azure App Service, the database must be stored on the platform's persistent
home path rather than temporary local storage. Before cloud sign-off, verify that
transactions survive an app restart and redeployment. If that test fails or file
locking proves unreliable, migration to Azure SQL becomes a deployment blocker,
not an optional follow-up.

### Backup

Create one consistent SQLite snapshot per day and upload it to a private Blob
Storage container. Use retention rules and managed identity where supported.
Completion requires restoring a snapshot into a clean environment and reconciling
row counts and monthly totals against the source database.

### AI insights

Azure OpenAI `gpt-4.1-mini` never reads Blob Storage or the raw transaction ledger.
The server performs this pipeline:

1. Query the selected month and the same elapsed period last month.
2. Compute exact totals, category deltas, budget values, and candidate findings.
3. Run arithmetic invariants and reject inconsistent candidates.
4. Send only aggregate facts and opaque fact IDs to Azure OpenAI.
5. Require strict JSON output containing only supplied fact IDs and placeholders.
6. Reject unknown facts, unsupported claims, literal numeric values, or malformed JSON.
7. Render placeholders from server-owned values and cache the validated result.
8. Fall back to fixed templates when generation or validation fails.

Regenerate and cache insights after a transaction or budget change. Raw merchant
names, card names, and individual transactions are not needed by the model.

## Exact Calculations

All currency is stored and calculated as integer cents.

- `spentCents = sum(transaction.amountCents)` for the selected period.
- `remainingCents = monthlyBudgetCents - spentCents`.
- `comparisonEndDay = min(todayDay, daysInSelectedMonth, daysInPreviousMonth)`.
- `monthToDateDeltaCents = currentSpendThroughEndDay - previousSpendThroughEndDay`.
- `categoryPercent = categorySpendCents / spentCents * 100`; use zero when total
  spending is zero.
- `categoryDeltaCents = currentCategorySpendThroughEndDay - previousCategorySpendThroughEndDay`.
- `cumulativeSpend[day] = sum(amountCents where transactionDay <= day)`.
- `sum(categoryBudgetCents) = monthlyBudgetCents` must hold before saving budgets.

Dates use a single configured household time zone. The database stores an ISO date
for the transaction's local calendar day so month boundaries do not depend on the
App Service server time zone.

## Delivery Buckets

Each bucket must pass its checks before the next begins.

### 1. Data integrity and transaction API

Build: migrate amounts from floating-point dollars to integer cents; add transaction
list, create, update, and confirmed-delete API behavior; validate every request.

Prove: API tests cover valid writes, invalid amounts and dates, missing references,
month boundaries, editing, and deletion.

Correct: a transaction round-trips without changing its amount or local date, and
all invalid requests return a clear 4xx response without writing data.

### 2. Monthly dashboard query

Build: one server summary for monthly totals, same-elapsed-day comparison, recent
transactions, category ranking, and cumulative daily trend.

Prove: fixture-based tests calculate every expected cent independently, including
zero spending, overspending, leap year, January rollover, and months of different lengths.

Correct: API results exactly match fixture arithmetic and contain no model-generated values.

### 3. Deterministic transaction search

Build: indexed SQL filters for merchant/description text, category, and card, with
stable sort order and pagination.

Prove: search tests cover combinations, case handling, no matches, duplicate dates,
and page boundaries.

Correct: every result satisfies every selected filter, with no vector service or LLM call.

### 4. Monthly and category budgets

Build: read and edit budgets by month while preserving prior months. Reject an
allocation set unless its categories equal the overall monthly total.

Prove: tests cover exact reconciliation, under-allocation, over-allocation,
overspending, and editing one month without changing another.

Correct: only exact allocations save, history remains unchanged, and remaining
amounts derive from the saved budget and transaction totals.

### 5. Validated insights

Build: deterministic candidate selection, sanity checks, strict Azure OpenAI output,
post-generation validation, caching, evidence links, and fixed-template fallback.

Prove: use a fake model response to test valid output, unknown fact IDs, invented
numbers, malformed JSON, timeouts, and arithmetic inconsistency. No test requires Azure.

Correct: the UI never displays an unsupported number or claim; model failure does
not remove useful deterministic insight content.

### 6. Azure persistence and recovery

Build: single-instance App Service configuration, persistent database path, private
Blob backup, retention, server-side secrets, and least-privilege identity.

Prove: restart and redeploy without data loss; restore a daily backup into a clean
environment; compare table counts and computed monthly totals; confirm the browser
bundle contains no Azure credential.

Correct: all checks pass locally first, then on Azure, while staying within the
approved monthly credit.

## Deterministic Planning Prompt

Use this prompt to generate or revise an implementation plan. Replace only values
inside angle brackets.

```text
You are a senior TypeScript engineer planning Pocket Watch, a single-user personal
budgeting web app.

GOAL
Answer only:
1. Where did my money go this month?
2. How does each category compare with last month?

FIXED STACK
- React + TypeScript + Vite
- Node.js + Express
- SQLite locally and for v1 single-instance Azure App Service
- Recharts
- Azure OpenAI deployment: <deployment-name>, model family gpt-4.1-mini
- Private Azure Blob Storage for daily SQLite snapshots

FIXED RULES
- No accounts or authentication.
- No affordability feature.
- No semantic search, embeddings, vector database, or Azure AI Search.
- SQL search covers merchant/description, category, and card.
- Store and calculate currency as integer cents.
- Compute every total, percentage, delta, ranking, and trend in deterministic code.
- Compare the selected month with the same elapsed day range last month.
- The LLM receives aggregates only and never calculates or invents a number.
- The LLM may only rewrite server-selected candidate facts.
- Reject invalid model output and show a deterministic fallback.
- Preserve every month of transaction and budget history.
- Category allocations must equal the overall monthly budget.
- Use one configured household time zone for transaction month boundaries.
- Keep all credentials server-side and use managed identity where practical.
- Azure deployment stays single-instance while SQLite is the live database.

FEATURES TO PLAN
1. Add, edit, and confirmed-delete transactions.
2. Monthly spent, budget remaining, and same-elapsed-period comparison.
3. Recent transactions.
4. Deterministic transaction search and pagination.
5. Ranked category breakdown with amount, percent, last-month delta, and drill-down.
6. Monthly category budgets that reconcile to the total.
7. Cumulative daily spending trend versus last month.
8. Up to three concise, neutral, validated insights with evidence links.
9. Daily private Blob backup and tested restore.

REQUIRED RESPONSE
Produce these sections in this exact order:
1. Assumptions: list only unresolved facts; do not silently invent requirements.
2. Architecture: components, trust boundaries, data flow, and why each Azure service is needed.
3. Schema changes: tables, columns, constraints, indexes, and migration order.
4. API contracts: method, route, validated inputs, response shape, and failure cases.
5. Exact calculations: formulas, date boundaries, rounding, and zero-data behavior.
6. Insight contract: candidate selection, JSON schema, validation, caching, and fallback.
7. Delivery buckets: smallest dependency-ordered vertical slices.
8. Verification: for every bucket state what to run, expected output, and observable correctness.
9. Azure feasibility gates: persistence, restart, redeploy, backup restore, identity, and cost.
10. Risks and rollback: severity, trigger, mitigation, and rollback for each material risk.
11. Out of scope: repeat every excluded feature explicitly.

For each delivery bucket, include exactly:
- Build
- Why this design fits
- Tradeoff
- Prove
- Correct result
- Depends on

Do not write implementation code. Do not recommend vectors, an agent framework,
or direct LLM access to files or the database. Flag contradictions instead of
resolving them by assumption. Ask at most three questions, and only when an answer
would change schema, security, cost, or delivery order.
```

## Deterministic Insight Prompt Contract

The application should use a strict JSON schema rather than relying on wording alone.
The model receives prevalidated `candidateFacts` and returns at most three rewrites.

```text
SYSTEM
You rewrite validated budgeting facts into concise, neutral language.
You do not perform arithmetic, infer causes, give financial advice, or create facts.

Use only candidate IDs, evidence fact IDs, and placeholders present in the input.
Do not output literal numbers, currency values, percentages, dates, merchant names,
or card names. Keep placeholders unchanged, including braces.

Return JSON matching the supplied schema and nothing else. If no candidate can be
rewritten without adding a claim, return {"insights":[]}.

USER
{
  "period": "<YYYY-MM>",
  "candidateFacts": <server-generated-candidate-facts-json>,
  "allowedPlaceholders": <server-generated-placeholder-list>,
  "maximumInsights": 3,
  "tone": "concise-neutral"
}
```

Server validation must confirm the JSON schema, candidate IDs, evidence IDs,
placeholder allowlist, maximum count, and absence of literal numeric text before
rendering placeholders from exact server-owned values.