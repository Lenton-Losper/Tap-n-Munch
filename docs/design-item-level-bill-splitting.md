# Design: item-level bill splitting — design only, not built

**Filed:** 2026-08-28, lowest priority of tonight's queue. Grounded in the actual settlement model
as it stands after tonight's work, not a green-field guess.

## What exists today, and where it stops

Settlement is per-ORDER, not per-item. `POST /api/terminal/tabs/[tabId]/settle` takes
`order_ids: string[]` and settles each order WHOLE — `owesMoney`/`isCashSettleablePaymentStatus`
partition orders, not lines, and `markOrderPaidConfirmed` marks one order paid at a time. A table
of four who each want to pay for their own dish today has exactly one lever: **per-order**
settlement — if each diner's items happen to be separate rounds/orders, "Settle Selected" already
lets staff pick which orders to charge to which payment. That is coincidental coverage, not item-
level splitting: a single ROUND with four diners' dishes on one order has no way to divide it.

`order_lines` (ADR-005) already carries the right GRANULARITY for a line-level split — one row per
item, with `quantity`, `name_snapshot`, and (from tonight's per-order total) a derivable per-line
price — but nothing on it today says WHO it belongs to for billing purposes. `tabs.members` exists
(used for `member_name` resolution on the terminal table view) and is the closest existing concept
of "the people at this table," but it is a display list, not a billing allocation.

## The shape

1. **A split is a per-order allocation, not a new state on the order.** An order stays exactly
   what it is today (one `orders` row, one `total`, one `payment_status`) until it is FULLY paid;
   splitting decides who is charged for what, across possibly-multiple settlement actions against
   the SAME order, not a rewrite of the order itself. This matters because order editing, refunds,
   and the receipt/audit trail are all keyed on `orders.id` today — inventing a second order per
   split share multiplies every one of those by however many ways the bill is cut, which is a much
   bigger and riskier change than the feature asks for.

2. **A new table, `order_line_allocations`** (name provisional): `order_line_id`, `quantity_
   allocated` (a line can itself split — two people sharing one pizza), `allocated_to` (a
   `tabs.members[]` entry reference, or a free-text name matching how `members` already works —
   TBD, see open question below), `amount`. Sum of `amount` across all allocations for a line must
   equal the line's own share of the order total (tax/service-charge apportionment is an open
   question, see below).

3. **Settlement reads allocations when they exist, falls back to whole-order when they don't.**
   `GET /api/terminal/tabs/[tabId]/lines` (tonight's own new route) already returns every line
   with its state; extending it to also carry `allocations: []` when present is additive — the
   existing per-order settle flow is completely unaffected for the (overwhelming majority of)
   orders nobody splits.

4. **A NEW settle mode, "settle by allocation"**, alongside today's "settle by order_ids": takes
   a set of `order_line_allocation` ids (or a `member` identifier and settles everything allocated
   to them) rather than whole order ids. Partial settlement of a single order already exists in
   spirit — `ready_to_pay_at` survives a partial settle when money remains (#318, live on
   production) — so the underlying "an order can be settled in more than one pass" capability is
   proven; this is one more way to decide which slice of an order a given pass covers.

## Where a manager or waiter would actually do this

Splitting has to happen BEFORE settlement, at the point a waiter (or a customer via QR, out of
scope here) says "these three items are Sam's, this one is Priya's." The natural place is the
existing terminal table view (`GET /api/terminal/tabs/[tabId]/lines` already renders per-order
lines) — a waiter taps a line, assigns it to a member, and the allocation write happens then, not
at settle time. Settle time becomes "pay for what's already assigned to this person," which is a
much simpler UI moment than trying to divide a bill while also trying to collect money.

## Open questions, a ruling away from being answered — not guessed here

- **Tax and service charge apportionment.** If three lines split evenly by subtotal but the order
  carries one flat tax figure, does each allocation carry a proportional slice, or is tax settled
  separately? `orders.tax`/`subtotal`/`total` today are order-level scalars, not per-line.
- **What "allocated_to" actually is.** `tabs.members` today is informal (display names entered at
  table-open time, per `buildMemberNameLookup`'s own docblock reasoning about `member_name`
  resolution) — is a bill split allocated to that same loose member concept, or does it need its
  own identity? Getting this wrong either overbuilds (a new identity system for a feature that
  does not need one) or underbuilds (an allocation that cannot survive a member being renamed
  mid-service).
- **Partial-line splits and quantity.** "Two people share one pizza" needs a line to divide by
  `quantity_allocated`, not just be wholesale-assigned — is fractional/partial-quantity splitting
  in scope for a first version, or is whole-line-per-person enough to ship first and extend later?
- **Refund/void interaction.** `order_lines` can already be voided (tonight's own fix,
  `voidOutstandingOrderLines`) — an allocation pointing at a voided line needs a defined behaviour
  (does the person's owed amount drop, and does anything tell them why) that this design does not
  resolve.

## Not attempted here

No schema, no route, no UI. This is the shape only, and the open questions above are exactly the
kind of thing that needs a ruling before any of this is buildable — not a default this session
should pick on its own.
