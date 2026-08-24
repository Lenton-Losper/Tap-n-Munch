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

---

## Scenarios, 2026-08-24

Six registered: three behaviours, each with its own negative control. Every control passed, so the
three clean results mean something.

```
double-tap                        1 submission from two concurrent taps, same key
double-tap-control                2 submissions with NO key          <- harness can see duplicates

staff-closes-table-mid-checkout   HTTP 403, 0 submissions
                                  "This table has been closed. Please scan the QR code to
                                   start a new session."
close-...-control                 HTTP 200, 1 submission             <- ordering works without a close

two-sessions-one-table            phone B REFUSED, 403 TAB_PIN_REQUIRED
                                  tab A pin_required=true has_pin=true
two-sessions-...-control          a first scan at a fresh table opens a tab

back-button-mid-payment           1 submission from two SEQUENTIAL taps, same key
back-button-...-control           2 submissions with DIFFERENT keys  <- harness can see duplicates
```

### What each was actually looking for

**Close table mid-checkout** — not whether the order is refused (it must be) but WHAT the customer is
told, and whether anything is left half-done. The close settles the tab, expires the session and
bumps `current_session_version`, so an order landing after it belongs to a session that no longer
exists. Result: refused with a 403 and a message that names the cause and the remedy. The failure
mode being watched for was a 5xx, which reads as "the app is broken" rather than "your table was
closed" — the difference between rescanning and giving up.

**Two sessions, one table** — the #211 / QRA-02 shape. `idx_tabs_one_open_per_table` guarantees the
second insert hits 23505; the recovery branch decides what happens next. Handing over the existing
tab with a fresh session token and no PIN would let a stranger add orders to somebody else's bill.
**Refused with TAB_PIN_REQUIRED, so that branch is gated on staging.** The scenario does not stop at
the refusal: had B received A's tab, it goes on to attempt an order on it, because reading a tab is
already anon-visible and ACTING on it is the exposure.

**Back button mid-payment** — the double tap with a gap in the middle, and the one the customer app
is most likely to get wrong: the cart is still populated after a back navigation, so the second tap
is a genuine second submission. It tests the idempotency key's LIFETIME rather than concurrency — a
key minted per render would not survive the navigation. Deliberately sequential; the concurrent case
is double-tap's job.

### Worth knowing

One table per scenario INCLUDING each control. A tab is unique per open table, so a second scenario
reusing a table is refused with TAB_PIN_REQUIRED — which looks like a finding and is the product
working. Eight scenarios, eight tables.

The two-sessions result is staging only. The 23505 recovery branch was an open exposure on
production at `fdb999a`; this run says nothing about whether production carries the gate.
