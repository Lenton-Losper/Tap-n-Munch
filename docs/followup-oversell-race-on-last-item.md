# Follow-up: two simultaneous orders can both pass the last-item stock check

**Status:** open, deliberately deferred on 2026-07-31. Not a blocker for the out-of-stock
block shipping — it is a pre-existing gap that check makes visible, not one it introduces.

## The gap

`checkStockSufficiency` (`lib/orders/check-stock-sufficiency.ts`) reads the ledger balance and
decides, then the order is created separately. Between those two steps another order can do
the same thing. Two customers ordering the last unit both read a positive balance, both pass,
and both orders are accepted — so stock goes to −1 rather than one of them being refused.

This is the classic read-then-write race, the same shape as the two already fixed tonight
(tab members, and edits during payment). The difference is that fixing it properly is not a
one-line conditional write, because the check and the insert are separated by pricing, payment
validation and order creation.

## Why it is not urgent

- It requires two orders for the *same* tracked item within the same short window, when that
  item is on its last unit. Narrow.
- The consequence is a single-unit oversell, which is what happens today anyway — the entire
  system currently allows unlimited overselling with no check at all. This makes the common
  case much better without making the rare case worse.
- It is **not** the cause of any measured stock discrepancy. The measured drift came from
  deduction ignoring `track_inventory`, which is fixed separately.

## MEASURED 2026-08-01: row-level locking does NOT fix this

Row locking was implemented and tested rather than assumed.
`check_stock_sufficiency_locked` (migration `20260801000000`) does the whole check in one
transaction and takes `SELECT ... FOR UPDATE` on the relevant `stock_items` rows, in id order,
before reading any balance.

Measured with 8 genuinely concurrent HTTP placements against a stock of 1
(`scripts/stock-verify-oversell-race-20260801.ts`):

| Scenario | Accepted | Refused |
|---|---|---|
| 8 concurrent orders, stock **1** | **8** | 0 |
| 8 concurrent orders, stock **0** | 0 | 8 |

**The lock changes nothing about the race**, and the reason is structural rather than a
locking bug: locking serialises the *check*, but nothing decrements between callers. Each one
waits its turn, reads a balance of 1, and correctly concludes it may proceed.

The deeper cause: **stock is only decremented at completion, not at placement.** No amount of
locking at placement can prevent overselling while placement consumes nothing. Even moving the
order insert into the same transaction would not fix it — the insert does not reduce stock
either.

The locked function was kept anyway, because it is a genuine improvement on its own terms and
a prerequisite for any real fix: it replaces four separate round trips with one consistent
read, so concurrent callers can no longer see a torn view of the ledger. It is simply not a
solution to this problem, and must not be described as one.

## What a real fix would look like

Not a bolt-on, and — per the measurement above — not a lock either. Placement has to consume
something, otherwise concurrent checks will always all pass.

1. **Reservations.** Placing an order writes a reservation against the stock item inside the
   locked transaction; available stock becomes `balance - outstanding reservations`;
   completion converts the reservation into the existing `sale` movement, and cancellation
   or expiry releases it. This is the only option that actually closes the race, because it
   is the only one where placement reduces what the next caller can see. It is a real feature:
   a new table, a lifecycle, and expiry handling for abandoned orders.
2. **Deduct at placement instead of completion**, reversing on cancellation. Smaller, but it
   changes what the ledger means — stock would drop for orders that are never served — and
   it would need a compensating movement on every cancellation path.
3. A materialised balance column with a `CHECK (balance >= 0)` constraint. The strongest
   guarantee, but the largest change: backfilling, and deciding what to do about the existing
   negative balances, which such a constraint would reject outright.

Option 1 is the right one, and it is a piece of work in its own right — not something to bolt
onto an out-of-stock check.

## Before picking this up

Read `docs/recipe-tracking-fix-handover-2026-08-01.md` for the surrounding context, and note
that production stock counts are currently unreliable (Receive Stock was broken for days;
recipe units are never converted). Serialising access to a wrong number does not make it
right — the counts should be trustworthy before this is worth doing.
