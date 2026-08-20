# PostgREST limit sweep — 2026-08-20

Every place the codebase can hit one of the two PostgREST limits that produced #322, ranked by
whether **real production data can cross it today**. Nothing is fixed in this pass.

Swept at `62b3575` — exactly what production serves.

## The two limits, as measured

| limit | where it bites | what happens |
|---|---|---|
| **~620 ids / ~24 KB request URI** | `.in()`, `.overlaps()`, `.contains()` — GET filters spell every id into the URI | upstream `400 Bad Request`; if the caller throws, a blank 500 |
| **1000 rows** | any read with no explicit `.range()` | **silent truncation** — no error, wrong numbers |

Both measured, not assumed. Staging: 620 paid orders → 200, 640 → zero-length 500. The identical
query run directly against PostgREST returns `Bad Request` at 640 ids / 23,694 bytes. Truncation:
1220 paid orders in a window, 1000 returned.

---

## 1. Id lists in GET filters

98 call sites. 22 pass constant arrays (status literals, `[...SOME_CONST]`) and are bounded by
construction. That leaves **~62 data-derived sites**. Production maxima:

| max ids today | % of the 620 ceiling | site(s) |
|---|---|---|
| 198 | **32%** | `menuItemIds` per restaurant — menu paths (`lib/supabase/menu.ts`, `lib/order-routing.ts`) |
| 37 | 6% | `stockItemIds` per restaurant — `lib/stock/queries.ts`, `check-stock-sufficiency` |
| 33 | 5% | `recipeIds` per restaurant — `lib/recipes/queries.ts`, `bulk-tracking-actions` |
| 11 | 2% | `restaurantIds` platform-wide — `app/admin/restaurants`, `lib/platform/dashboard`, `api/auth/contexts` |
| 9 | 1% | `ids` in `auto-cancel-stale-pos-orders` |
| 7 | 1% | `menuItemIds` / `categoryIds` per **order** — `calculate-order-pricing`, `order-routing` |
| 3 | 0% | `orderIds` per **tab** — terminal settle, table close |
| 3 | 0% | session ids per tab — `lib/guest-orders/queries.ts` |
| 1 | 0% | `order_ids` per payment event — `.contains()` sites |
| 0 | 0% | `transferIds` — no transfers exist yet |

**Nothing crosses the ceiling today. The closest is 32%.**

`getPaymentProjections` is the only site that chunks, and it is the only one that ever exceeded the
ceiling — because it was the only one fed by a *date-window* set rather than a per-entity set. That
is the distinguishing property, and it is the thing to watch: **an id list derived from a date range
or a whole-restaurant scan is unbounded; one derived from a single order, tab, or catalogue is not.**

Two sites are one growth step from mattering:

- `menuItemIds` per restaurant at 198 — a restaurant with ~3× today's menu crosses it.
- `restaurantIds` platform-wide at 11 — bounded by tenant count, so it grows with the business, and
  every platform/admin page uses it.

**Unreadable, not cleared:** `goods_received_line_items` is not exposed through PostgREST, so
`lineItemIds` per GRV in `lib/stock/queries.ts` could not be measured. It is per-GRV, so it is
almost certainly small, but it is unmeasured rather than proven safe.

---

## 2. Unbounded reads that can exceed 1000 rows

Only **one table exceeds 1000 rows in production at all**:

| rows | table |
|---|---|
| **2810** | `orders` |
| 489 | `payment_events` |
| 400 | `menu_items` |
| 324 | `stock_movements` |
| ≤59 | everything else |

Of those 2810 orders, **1315 have `restaurant_id = NULL`** — legacy Firebase-era test data
(`firebase_restaurant_id` = `restaurant_test_01..09`, 2026-04-27 to 06-16). Every real read filters
by `restaurant_id`, so those rows are unreachable and must not be counted as risk.

50 unbounded reads on `orders`. Two are **false positives in my scanner** — both in
`app/api/orders/history/route.ts`, which applies `.range()` to a stored builder the chain heuristic
cannot see; both are genuinely bounded. The remaining 48 by scope:

### Restaurant-wide with no date filter — the ones that will cross first

| max rows today | % of 1000 | site |
|---|---|---|
| **849** | **85%** | `lib/supabase/orders.ts:413` — every order for a restaurant, no filter at all |
| **740** | **74%** | `app/api/analytics/orders-summary/route.ts:22` — `select('*')`, all paid orders, no date bound |
| **739** | **74%** | `app/api/terminal/orders/route.ts:36` — `select('*')`, all live statuses |
| 5 | 0% | `lib/supabase/orders.ts:190` — open orders only |
| 5 | 0% | `lib/supabase/orders.ts:170` — pending card only |

All three leaders are **FNB ChowNow**, the trading restaurant. None truncates yet; the first will at
roughly 1.2× today's volume.

### Global — no restaurant filter

13 sites. Most are narrowed by another equality (`resolve-order-by-merchant-order` by reference,
`issueReceipt` by order id) and are effectively narrow. The genuinely set-shaped ones:

- `lib/orders/auto-cancel-stale-pos-orders.ts:193` — pending POS card orders across all restaurants.
  **9 today.** Grows with unpaid POS attempts, not with sales.
- `lib/payments/reconcile-orphan-payments.ts:79` — orphan-payment candidates.
- `lib/platform/dashboard.ts:388` — dated, so bounded by the window.

### Dated (restaurant + date window)

- `lib/reports/get-report-data.ts:90` — **see §3**
- `lib/supabase/analytics.ts:29` and `:97` — same shape as the report path, same exposure
- `app/api/orders/history/route.ts:146` — **fixed in 62b3575**, now paginated

### Narrow — 26 sites

Scoped to one tab, table, order or session. Bounded at 3–5 rows today. No action.

---

## 3. `getReportData` — the answer is "not yet", with a caveat that already bit

`lib/reports/get-report-data.ts:90` selects orders with **no `.range()`**, and feeds
`getPaymentProjections` with **every returned id**. It backs all three of:

- `app/api/orders/history/export/route.ts` (CSV export)
- `app/api/admin/restaurants/[id]/reports/email/route.ts`
- `app/api/cron/send-scheduled-reports/route.ts` (**the nightly emails**)

**No client's monthly report has been truncated. Not one.**

| restaurant | all-time orders | worst month |
|---|---|---|
| FNB ChowNow | 849 (85% of cap) | 2026-07 — **695** |
| Mingle Brew & Pour | 490 | 2026-08 — 413 |
| Digi Cofee | 11 | 2026-07 — 11 |
| Riviera | 8 | 2026-08 — 8 |

The only bucket above 1000 is the `restaurant_id = NULL` test data, which `getReportData` cannot
select because it filters `.eq('restaurant_id', …)`.

**But the id ceiling did bite this path, before today.** Any report or export whose window returned
more than ~620 orders passed that many ids into the single un-chunked `.overlaps()` and threw.
That covers:

- **FNB ChowNow, July 2026 — 695 orders.** A July report or export would have failed.
- **FNB ChowNow, all-time — 849 orders.** Any full-history export would have failed.

Failed, not truncated — so the output was a missing or errored report, not a wrong number. `62b3575`
chunked `getPaymentProjections`, so both now work. **The 1000-row truncation in this path is still
present and unfixed**; it simply has not been reached.

FNB ChowNow needs ~18% more volume in a single month, or ~1.2× all-time, to start silently
under-reporting revenue in the nightly email.

---

## Ranked, one list

| # | risk | site | today | crosses when |
|---|---|---|---|---|
| 1 | **truncation, money-facing** | `lib/reports/get-report-data.ts:90` | 849 / 1000 | FNB ChowNow +18% in a month |
| 2 | truncation, money-facing | `lib/supabase/analytics.ts:29`, `:97` | same window shape | same |
| 3 | truncation | `lib/supabase/orders.ts:413` | 849 / 1000 | same |
| 4 | truncation | `app/api/analytics/orders-summary/route.ts:22` | 740 / 1000 | ~1.35× |
| 5 | truncation | `app/api/terminal/orders/route.ts:36` | 739 / 1000 | ~1.35× |
| 6 | id ceiling | `menuItemIds` per restaurant (menu paths) | 198 / 620 | ~3× menu size |
| 7 | id ceiling | `restaurantIds` platform-wide | 11 / 620 | ~56× tenants |
| 8 | unmeasured | `lineItemIds` per GRV, `lib/stock/queries.ts` | unknown | table not exposed to PostgREST |
| — | fixed | `getPaymentProjections`, `orders/history` summary | chunked + paginated in `62b3575` | — |

Everything below #7 is at or under 6% of its ceiling.

## What this sweep does not establish

- Scope classification is by static chain analysis. A query built across several statements can be
  misread — two such false positives were found and are named above; there may be more.
- Only `orders` was swept for unbounded reads, because it is the only table over 1000 rows today.
  `payment_events` (489) and `menu_items` (400) will need the same pass before they grow.
- `goods_received_line_items` could not be read.
- Growth rates are not modelled. "Crosses when" is arithmetic on today's counts, not a forecast.
