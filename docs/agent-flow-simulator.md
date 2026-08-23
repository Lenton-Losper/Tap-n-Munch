# Customer-flow simulator

**Staging only. Never production. Never a real card.**

```bash
node node_modules/tsx/dist/cli.mjs scripts/flow-simulator.ts               # all scenarios
node node_modules/tsx/dist/cli.mjs scripts/flow-simulator.ts double-tap    # one
```

It refuses to run unless `NEXT_PUBLIC_SUPABASE_URL` contains the staging project ref.

## Why it exists

The double-tap defect of 2026-08-23 was found by the owner tapping twice, not by reading code. That
class — bad states reached by impatient, confused or unlucky sequences — is invisible to static
review and to unit tests, because every individual call succeeds. Only the *order* of calls is wrong.

So this drives the **real deployed HTTP flows** against staging, in sequences a customer actually
produces.

## Severity ranking

Findings are reported worst-first in this order:

| rank | severity | meaning |
|---|---|---|
| 1 | `MONEY_TWICE` | money can be taken more than once |
| 2 | `ORDER_LOST` | an order the customer placed disappears |
| 3 | `STRANDED` | the customer cannot recover without staff |
| 4 | `COSMETIC` | wrong or confusing, but recoverable alone |

## Prove the harness before trusting a clean run

**Every run includes a negative control**, and a clean run means nothing without it. The control
fires two taps with **no** idempotency key and expects **two** submissions. If it sees one, the
harness cannot distinguish "protected" from "not looking properly", and every other green result in
that run is worthless.

```
=== double-tap-control (negative control) ===
  two taps, NO key -> orders created: 2 (expect 2; if 1, the harness cannot see duplicates)
```

**The control caught two harness bugs on its first two runs**, which is the whole argument for having
it:

1. **Run 1 — everything 403.** A guest order is refused unless an **open tab** exists at the table
   (`app/api/orders/route.ts`), and a tab needs a `restaurant_tables` row. The simulator was placing
   orders at a table nobody had scanned. Fixed by seeding tables and opening the tab over HTTP, as a
   customer does.
2. **Run 2 — HTTP 200 but "0 orders created".** The seeded venue reviews orders, so submissions land
   in **`order_requests`**, not `orders` — the response says so with `status: 'waiting_review'` and a
   `requestId`. The harness was counting one table and calling a successful order a failure. It now
   counts **both** surfaces.

Both would have produced confident, wrong reports. Neither was visible without the control.

## Seeding and cleanup

Each run seeds its own restaurant, menu item and **six tables** — one per scenario, because a tab is
unique per open table and a second scenario reusing a table is correctly refused with
`TAB_PIN_REQUIRED`. That refusal is the product working, not a finding.

Cleanup runs in `finally`, so it happens even when a scenario throws mid-sequence: `order_requests`,
`audit_logs`, `orders`, `tabs`, `restaurant_tables`, `menu_items`, then the restaurant.

## Scenarios

| scenario | status |
|---|---|
| double-tap place/pay | **implemented** |
| double-tap negative control | **implemented** |
| triple-tap every submit | to build |
| back button mid-payment, forward, submit again | to build |
| refresh confirmation before / during / after settlement | to build |
| close the tab mid-payment, re-scan the QR | to build |
| two sessions on one table ordering simultaneously | to build |
| scan a QR while another customer at that table is paying | to build |
| lose connectivity mid-submit and retry | to build |
| pay, then immediately edit the order | to build |
| staff close the table while a customer is mid-checkout | to build |

## First run — result

**The harness caught the defect it was built to catch.**

```
=== double-tap ===
  two taps, SAME idempotency key -> HTTP 200/200
    submissions created: 1  (orders=0 order_requests=1)
  confirmation lookup by ORDER ID -> HTTP 400, orders found: 0

=== double-tap-control (negative control) ===
  two taps, NO key -> orders created: 2
```

Two things separate here, and conflating them is how this got misread as a double-tap bug:

- **The double tap itself is protected.** Two concurrent taps with the same `x-idempotency-key`
  produced exactly **one** submission. Order creation's idempotency works.
- **The confirmation screen is what fails.** Resolving it by the order id returns nothing, so the
  customer sees *"Order not found"* for an order that exists and is being prepared. Filed
  separately; ranked `STRANDED` because the only button on that page leaves the page.

## Operating contract

- **Staging only**, enforced by a project-ref check that throws.
- **Never a real card.** Seeded venues carry stub Finatic credentials.
- **Reports, does not fix.** Every finding gets an issue with the exact reproduction sequence.
- **Seeds and cleans up its own data**, in `finally`.
- **A run without a passing negative control is void** — say so rather than reporting its findings.
