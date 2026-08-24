# CLAUDE.md — Project Guardrails

> **Purpose:** Hard guardrails and a tight feedback loop for this project.
> Read this at the start of every working session. If a proposed action conflicts
> with anything here, **STOP and get explicit approval before proceeding.**

---

## Communication Style

- Explain everything in plain English for a new developer.
- Be concise and lead with the direct answer.
- Keep visible reasoning and progress updates concise. Do not narrate private
  chain-of-thought or every internal step; summarize only what is being checked,
  why it matters, what was learned, and what happens next.
- Format multi-part reasoning as a clear decision trail instead of a paragraph
  blob: lead with the conclusion, use numbered steps for sequential logic, and
  use short descriptive headers when the explanation covers distinct topics.
  Do not add headers or lists to a short answer that is already easy to scan.
- Match explanation depth to the user's demonstrated technical comfort. Start
  in plain English, introduce one necessary technical detail at a time, and go
  deeper when the decision, risk, or user's question calls for it.
- When a reasoning update needs technical context, briefly explain the relevant
  fundamental concept in plain English for a new developer.
- Explain one new concept at a time, including why it matters, and use a small
  concrete example or analogy only when it makes the idea easier to understand.
- Define necessary technical terms briefly.
- For errors, explain what failed, why, and the next step.
- When suggesting or implementing code changes, explain the relevant software
  engineering principle or design technique in plain English, why it fits this
  situation, and any meaningful tradeoff.
- For every delivery-bucket explanation, list the files expected to change. For
  each file, concisely state what it already does, what the bucket will change,
  one concrete app use case, and the design pattern being applied.
- Keep the user actively involved in technical decisions. The goal is to teach
  the reasoning, not replace the user's judgment or take over the project.

---

## 1. North Star (LOCKED — do not drift)

**A personal budgeting web app that answers:**

> *"Where did my ~$2,000 go this month, and how does each category compare to
> last month?"*

Every feature must serve **spending awareness through clear monthly and category comparisons.**
If a feature does not help answer the north-star question, it is **out of scope**
(or explicitly deferred with sign-off).

**Core question the app answers:** "Where is my money going?"

---

## 2. Confirmed Decisions (the locked spec)

| Area | Decision |
|------|----------|
| User | Single user, personal (just me). No accounts, no auth. |
| Platform | Responsive web app — **desktop AND mobile must both feel intuitive**. |
| Budget model | Per-month budgets, editable each month, **history preserved**. Default $2,000 total. |
| Time navigation | Month stepper (`‹ August 2026 ›`). |
| Comparison | This month vs. last month, side by side, per category. |
| History | Keep everything forever. |
| Entry UX | Big tappable **chips/buttons** for card + category + amount. Fast. |
| Cards (preloaded) | Chase Freedom Unlimited, Chase Sapphire Reserve, Citi Custom Cash, Capital One Venture X. |
| Categories | Groceries, Dining, Transport/Gas, Shopping, Bills/Utilities, Entertainment, Health, Traveling, Gym, Amazon, Family Stuff, Other. |
| Capture v1 | Manual quick-add (type/paste). |
| Capture later | Parse **forwarded bank transaction emails** to auto-fill (self-hosted). |
| Hosting | **Local-first** for verification, then **Azure App Service B1** (~$13/mo) on personal Azure credit (~$150/mo). |

---

## 3. Technical Guardrails

- **Stack:** React + TypeScript (Vite) · Node/Express · **SQLite** (local file) · Recharts.
- **Local-first:** Must run 100% locally, free, before any cloud deploy.
- **Security (non-negotiable):**
  - Azure OpenAI key and any secrets stay **server-side only** — never shipped to the browser.
  - No secrets committed to git. Use `.env` (gitignored) + `.env.example`.
  - Validate/parse all external input (email content, uploads) at the boundary.
- **Data integrity:** SQLite is single-file, single-user — fine for this app. Full history retained.
- **No-go patterns:** no premature abstractions, no features "for later users," no
  dependencies that require paid third-party bank data.

---

## 4. AI Guardrails

- **Math owns the numbers. The LLM owns the words.**
  - All totals, budgets, projections, and month-vs-month deltas are computed by
    **plain arithmetic on SQLite data** — exact, deterministic, testable.
  - **Azure OpenAI `gpt-4.1-mini`** receives the *already-computed* figures and
    produces narrative insights/highlights only.
- **The LLM must NEVER invent a dollar figure.** It explains and prioritizes; it
  does not calculate. Any number it outputs must be traceable to a value we passed in.
- AI insights are an **enhancement layer** — the app must be fully useful with AI off.

---

## 5. Hard NOs / Anti-Goals  ⚠️ NEEDS YOUR SIGN-OFF

*(Drafted from our decisions — confirm or edit.)*

- ❌ No multi-user, accounts, or authentication.
- ❌ No investment / portfolio / net-worth tracking.
- ❌ No bill-pay or moving real money.
- ❌ No third-party bank aggregation APIs (Plaid, Yodlee, etc.).
- ❌ No paid outsourced APIs **except Azure OpenAI** (approved, inside credit).
- ❌ No feature that doesn't serve the north-star question.
- ❌ No cloud deploy until it works and is verified locally.

---

## 6. External Signals — Reality Checks  ⚠️ NEEDS YOUR SIGN-OFF

*(Drafted — confirm the ones that matter to you.)*

We are on track only if these hold true:

1. **Dogfooding:** I (the user) actually log real purchases and open it regularly.
2. **Speed to log:** Adding a transaction takes **< ~10 seconds** on mobile.
3. **Spending awareness:** this month, last month, and category changes are clear
  in **< 5 seconds** of opening the app.
4. **Numbers match reality:** app totals reconcile with real card statements.
5. **Cost stays in budget:** Azure spend stays well under the ~$150/mo credit.

If a signal is failing, we stop adding features and fix the signal first.

---

## 7. Definition of Done (per bucket)

A bucket is **DONE** only when:

- [ ] It produces something visible and usable at a checkpoint.
- [ ] It serves the north-star question (or is an approved foundation).
- [ ] It has a **verification plan that was run** (see §8) — not just "it compiles."
- [ ] It works **responsively** on desktop and mobile (once UI exists).
- [ ] No secrets committed; local-first still holds.
- [ ] The user reviewed the output and explicitly approved moving on.

---

## 8. Verification Plan Requirement (MANDATORY)

**Before building anything multi-step, write the verification plan first.**

Every bucket must state up front:
1. **What we'll build.**
2. **How we'll prove it works** (the exact check: run command, expected output,
   click-through, or test).
3. **What "correct" looks like** (observable result).

No bucket is considered complete until its verification steps have actually been
executed and the expected result observed.

---

## 9. Reality-Check Cadence

- **Every bucket checkpoint:** stop, demo, verify against §7 and §8, get sign-off.
- Re-read §1 and §5 at each checkpoint to confirm we haven't drifted.

---

## 10. Tools & Skills Playbook  ⚠️ NEEDS YOUR SIGN-OFF

*(Proposed defaults mapping our available tools/skills to each phase. Confirm or trim.)*

**Verification — every checkpoint (supports §8):**
- **Browser automation (Playwright)** to click-test the UI and capture screenshots as proof.
- **Screenshot desktop (~1280px) + mobile (~390px)** viewports to prove the responsive requirement.
- **Unit tests on all math** (totals, projections, month-vs-month deltas) — numbers must be exact.
- **Compile + lint/error check** must pass before any checkpoint is presented.

**Design & prototyping — before coding a bucket:**
- **Excalidraw skill** for architecture + data-flow diagrams (schema, API, email-parsing pipeline).
- **web-artifacts-builder skill** for a quick throwaway UI mockup to agree on layout before building.

**Azure & AI — deploy + insights buckets:**
- **Azure MCP tools** to provision App Service B1 + the Azure OpenAI resource.
- **Azure pricing/quota checks** before deploy — confirm cost stays under the ~$150/mo credit (signal #5).
- **microsoft-foundry skill** for wiring `gpt-4.1-mini` insights correctly.
- **Azure best-practices + security checks** at deploy time.

**Data reconciliation & backup — supports signal #4:**
- **xlsx skill** to import a real card statement and reconcile it against app totals.
- **xlsx/CSV export** of transactions for backup anytime.

**Memory & continuity — every session:**
- **Repo memory** stores the stack, run commands, and schema decisions.
- **Re-read `CLAUDE.md`** at session start; never drift from §1.
- **Log every scope change** to the Drift Log (§12).

---

## 11. Decision Authority

- **The user approves ALL scope and direction changes.**
- I may make small implementation choices (naming, file layout, styling details).
- Any change to §1–§6 requires **explicit user sign-off** and is logged in §12.

---

## 12. Decision / Drift Log

Record every scope decision or direction change here (date — decision — why).

- 2026-08-17 — Project intent locked: awareness-first personal budgeting web app.
- 2026-08-17 — Stack chosen: React/TS + Node/Express + SQLite, local-first → Azure B1.
- 2026-08-17 — AI role fixed: math owns numbers, Azure OpenAI `gpt-4.1-mini` owns narrative.
- 2026-08-17 — Guardrails file created.
- 2026-08-19 — Learning-first collaboration added: explain engineering principles,
  reasoning, and tradeoffs so the user stays involved and builds understanding.
- 2026-08-19 — Redesign direction approved: rename to Pocket Watch; use a dark,
  transaction-first dashboard with Overview, Transactions, Budgets, and Insights;
  preserve the north-star scope and explicitly exclude broader wealth features.
- 2026-08-20 — Removed the "Can I afford this?" feature and narrowed the north
  star to monthly spending awareness and category comparison.
