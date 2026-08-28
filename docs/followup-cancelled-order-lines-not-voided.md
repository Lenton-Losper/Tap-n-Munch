# Followup: cancelling an order does not void its lines

**Filed:** 2026-08-28
**Status:** FIXED 2026-08-28. `lib/orders/order-lines.ts`'s `voidOutstandingOrderLines()`, wired
into both independent cancel-writers (`cancelOrderWithTrail`, and the stale-order sweep's own
`cancelByIds`). See that commit for the per-station-half voiding rule and the two writers found.

## What happened

Walking the kitchen board on staging (`staging test`, `a1999166-ddfa-40d1-ad1f-2f01282a1652`), the
board showed empty — "Nothing ready to run" / "Nothing waiting" — despite real order_lines existing
with `kitchen_state: outstanding`.

Measured directly: orders #12–18 (7 orders) all have `orders.status = 'cancelled'`. Their
`order_lines` are real, unstarted, undeleted — 16 lines total, `kitchen_state: outstanding` on every
kitchen/both line (Ribeye, Burger, Fries, Schnitzel, Sharing platter, Lager). The 9 currently-open
(non-cancelled) orders at the same restaurant have **zero** `order_lines` attached at all.

## Root cause

Nothing cancels an order's `order_lines` when the order itself is cancelled. The real domain model
(`lib/orders/order-lines.ts`) has a `'voided'` state specifically for this:

> `voided` -- cancelled or amended at the terminal.

But nothing in the terminal's order-cancellation path actually writes it. A cancelled order's lines
sit at whatever state they were in when the cancellation happened — in the case measured here,
`outstanding`, i.e. indistinguishable from real, live, unstarted work.

## Why this is not a station-screens bug

`GET /api/station/lines` (the real board-read route) filters lines to NOT-FINISHED for the
station asked, but has no join on `orders.status` at all — it has no way to know an order was
cancelled, because nothing tells it via the data it reads (`order_lines.kitchen_state`/`bar_state`).
The station screens' own placeholder read route (superseded, but still relevant to this finding)
happened to filter by `orders.status NOT IN (completed, cancelled)`, which is why the *specific*
symptom here was an empty board rather than the more dangerous shape below — but that filter is
incidental, not a fix, and does not exist in the real, already-merged contract.

## The real risk

Once station screens read through the real `GET /api/station/lines` contract (in progress — see
the bump-route rebuild), a cancelled order's lines will **not** be filtered out by anything, because
that route has no `orders.status` awareness. A customer or waiter cancels an order at the terminal,
and the kitchen or bar board keeps showing it as live, un-started work — a cook could cook food that
was already cancelled, or a bar could pour a cancelled round.

## Fix (not implemented here)

Whatever writes `orders.status = 'cancelled'` (or the equivalent amend/void path) at the terminal
needs to also write `order_lines.kitchen_state`/`bar_state = 'voided'` for every line still on that
order that hasn't already reached `'ready'`. This is an `order_lines` write, not a station-screens
read-side patch — filtering by `orders.status` in every board-reading route is treating the symptom
in N places instead of the cause in one.
