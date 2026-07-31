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

## What a real fix would look like

Not a bolt-on. Options, roughly in order of preference:

1. **Do the check and the insert in one database transaction**, taking the same
   `pg_advisory_xact_lock(hashtext(stock_item_id))` that `deduct_recipe_stock` and
   `dispatch_transfer` already use, so concurrent orders on the same stock item serialise.
   Consistent with the locking already in the codebase.
2. **A DB-side function** that validates and creates the order atomically, which would also
   close the gap for any future caller rather than just the two routes wired today.
3. A materialised balance column with a `CHECK` constraint — the strongest guarantee, but the
   largest change, and it would need backfilling and careful handling of the existing
   negative balances.

Option 1 is the smallest change with a real guarantee.

## Before picking this up

Read `docs/recipe-tracking-fix-handover-2026-08-01.md` for the surrounding context, and note
that production stock counts are currently unreliable (Receive Stock was broken for days;
recipe units are never converted). Serialising access to a wrong number does not make it
right — the counts should be trustworthy before this is worth doing.
