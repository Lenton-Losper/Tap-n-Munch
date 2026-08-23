# Production deploy — 2026-08-22 — every cancel path writes an audit row

Shipped alone, ahead of waves 2–8, because production was producing untracked cancellations every
day it waited.

## What went out

| | |
|---|---|
| main before | `bbce8cb3a351ce81e466df496203f77353b7a762` |
| main after | `9dd2d3b8935720f3f9dcb1fe31ccb1fb5ee7bf97` |
| migrations | **zero** — confirmed, no file under `supabase/migrations/` touched |
| runtime files | `lib/orders/cancel-order-with-trail.ts` (new), `lib/orders/auto-cancel-stale-pos-orders.ts`, `app/api/terminal/orders/[orderId]/status/route.ts` |

Deploy: `workflow_dispatch` of `production-worker.yml`, run `32567861486`, conclusion **success**.

### Baseline, before

All three hostnames on `bbce8cb`, 5/5 reads each.

### Verification, after — 20/20 per hostname

```
flashtap.app             20/20 on 9dd2d3b
www.flashtap.app         20/20 on 9dd2d3b
riviera.flashtap.app     20/20 on 9dd2d3b
```

Sampled 20×, not spot-checked: the worker rolls out gradually and a single cache-busted request can
return either version for about two minutes.

## Why this was authored on main rather than promoted

**This is deliberate divergence and it will produce a conflict later.** The staging versions of both
runtime files also carry waves 6 and 8 — the terminal success contract, the unrecognised-status
guard, the amount-gate inversion. Those change money *decisions* and are not ruled for production.
Promoting the file would have shipped them as a side effect of an observability fix.

So the production change is **semantically equal to staging's and textually different**. The
`cancelByIds` hunks WILL conflict when waves 6 and 8 land. **Resolve toward the staging version** —
it is a superset of what is on main now. The conflict is the intended outcome: it is visible, and a
silent divergence would not be.

`lib/orders/cancel-order-with-trail.ts` is byte-identical on both branches.

## What was proved, and what was not

**Proved on production:** the deployed commit is the new code, 20/20 on three hostnames.

**NOT proved on production: that a cancellation now writes its row.** There was no cancellation to
observe and none was manufactured. Measured at deploy time, all **7** pending POS orders on
production carry a `paycloud_merchant_order_no`, so every one of them routes to Finatic, is answered
E04111, and is skipped — **zero** would reach the cancel path. The most recent `order.cancelled`
rows are the nine from the 2026-08-21 operator ruling, which predate this change.

Behaviour is proved on staging instead, two-sided and mutation-verified: with both audit inserts
bypassed, 6 of 12 tests fail.

**A consequence worth keeping in view:** because every currently-stale POS order has a gateway
reference, the `no_gateway_reference` cancel path may fire rarely in production. The 90
`auto_timeout` rows accumulated from orders that had no reference. Absence of new audit rows over
the next days is therefore **not** evidence the fix failed — check whether any cancellation happened
at all before drawing that conclusion.

## Open, and staying open

Recorded so they are not quietly promoted to settled facts.

- **When #456/#500/#546 and Digi Cofee #9 were flipped is unrecoverable.** No `cancelled_at`, no
  audit row, and `orders.updated_at` is NULL on all 2992 production orders. Bounded only by
  construction — after each order's `paid_at`/`placed_at`, before `c1471a7` reached production.
- **Who tapped Decline was never recorded.** The pre-`c1471a7` route stored no terminal id, no staff
  id, no audit row. Not recoverable from the database.
- **The anon RLS UPDATE lockdown (`20260701160000`) is partially confirmed as deployed.** Probed
  2026-08-22 against production with the anon key, targeting a deliberately non-existent order id so
  no real row could change:
  - `total` → **42501 permission denied** — the column-level GRANT restriction IS live
  - `status` → no permission error — `status` IS in the anon grant, exactly as written
  - the `WITH CHECK (status = 'ready_for_terminal')` half is **still unproven**: a non-existent row
    never triggers a WITH CHECK. Proving it needs a real order, which was not touched.

## Filed as a question, not a defect

**The terminal's order list has no channel filter.** `app/api/terminal/orders/route.ts` selects by
restaurant and status only, so **kiosk and customer-placed orders appear on the till**, with Decline
live on anything at `status='pending'`. That is how Digi Cofee #9 — a kiosk order, customer "Bob" —
was cancellable from the terminal.

This may well be intended: staff plausibly need to see and manage kiosk orders. The question is
narrower than "should kiosk orders show":

1. Should the till be able to **cancel** an order the customer placed themselves?
2. Decline does not consult `payment_status`, so it is live on a **paid** order too. That is the
   mechanism behind #456/#500/#546 — the same button, on orders the webhook had already settled.

Not filed as a defect and not changed. It needs a decision about how the till and the kiosk are
meant to relate.
