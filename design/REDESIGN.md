# Pocket Watch Redesign Checkpoint

## What We Will Build

A responsive, interactive dashboard mockup that uses the supplied finance dashboard as inspiration without copying its layout. The overview will prioritize recent transactions and category visibility, supported by exact budget summaries, category spending, and month-over-month comparison.

### Approved Product Decisions

- Product name: Pocket Watch.
- Dark, dashboard-only interface with no persistent navigation column.
- Transactions and budgets expand into large dismissible workspace overlays from the overview.
- Monthly status bar: spent this month, budget remaining, and change from last month share one compact bar.
- Recent transactions: a prominent wide table with merchant, category, card, date, and amount.
- View all transactions: opens a scrollable workspace with filters and full editing controls.
- Adding a transaction from that workspace opens a smaller nested dialog without closing the transaction list.
- Transaction actions: edit, quick category change, duplicate, and confirmed delete.
- Add Transaction: a centered action sits close to the bottom edge and opens a compact bottom sheet.
- Spending breakdown: donut chart with a ranked category list.
- Category budgets: allocated amounts must reconcile with the monthly total; each row shows current spending, progress, and last month's value.
- Edit budgets: opens a workspace for creating, changing, and deleting category budgets.
- Creating a category budget opens a smaller nested dialog without closing the budget manager.
- Trends: one panel switches between spending pace and income-versus-expenses; income is a monthly setting.
- Insights: a tappable news-style ticker near the top continuously slides deterministic figures; tapping the text reveals more detail. The app remains useful when AI is unavailable.
- Explicitly excluded: Goals, Bills, Investments, Net Worth, account totals, and notifications.

## Verification Plan

1. Open the self-contained mockup at a desktop viewport around 1280 px wide.
   - Correct means the top insight strip, unified monthly bar, recent-transactions table, category analysis, budget progress, and trend chart use the full desktop width without overlap or horizontal page scrolling.
2. Open the same mockup at a mobile viewport around 390 px wide.
   - Correct means the protruding Add Transaction action is usable, all three monthly figures remain readable in one bar, recent transactions retain merchant/category/amount, controls fit their containers, and the page has no horizontal scrolling.
3. Exercise the key interactions.
   - Correct means month controls update the label, Add Transaction opens and closes a compact bottom sheet, tapping the ticker reveals insight detail, View all opens a scrollable transaction workspace, Edit budgets opens a budget-management workspace, and every overlay closes with its close control or Escape.
4. Run an HTML structure check and inspect browser console output.
   - Correct means the document parses, interactive controls have accessible labels, and there are no runtime errors.
5. Capture desktop and mobile screenshots for the checkpoint review.
   - Correct means both screenshots preserve the transaction-first hierarchy and dark visual direction.

## Implementation Boundary

This checkpoint is a throwaway design artifact. Production React, Express, and SQLite code will not change until the user reviews and approves the mockup.