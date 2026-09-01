# The stock deduction contract

**What this is:** the single written statement of when stock moves, what makes it idempotent, and
what happens on a retry, a void, a cancellation or a refund. Until now this existed only as
comments spread across three migrations and four API routes, which is how the two-sided
`track_inventory` bug survived for weeks.

Pinned by `__tests__/stock-deduction-contract.test.ts`. If you change the behaviour, that test
fails and you update this document in the same commit.

Every figure below was measured read-only against production on **2026-09-01**.

---

## 1. The model that already exists

There is no stored balance column anywhere. **A stock level is `sum(stock_movements.quantity_delta)`**
for that stock item — an append-only ledger, which is what makes the audit trail and the balance
the same object.

| Concern | Where it lives | State |
|---|---|---|
| Quantities | `stock_movements` ledger, summed | working |
| Adjustments / counts | `lib/stock/actions.ts` → `reason: 'adjustment'` | working |
| Goods received | GRV flow → `reason: 'received'` | working |
| Transfers | `stock_transfers` + `transfer_in` / `transfer_out` | working |
| Sale deduction | `deduct_recipe_stock` trigger | working |
| Low / out of stock | `computeStockStatus` (`lib/stock/format.ts`) | working |
| Negative-balance detection | `lib/stock/negative-balances.ts` | working, **0 negatives live** |
| Placement refusal | `check_stock_sufficiency_locked` | working |

Production, 2026-09-01: 47 recipes across 4 venues, 58 organisation stock items, 428 movements
(`sale` 304, `adjustment` 90, `received` 34), **0 negative balances**.

---

## 2. WHEN stock is deducted

**At order completion. Once. From a database trigger, never from application code.**

```
trg_order_completion_deducts_stock
  AFTER UPDATE OF status ON orders
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
```

Three consequences worth stating because each has already caught someone out:

1. **Placement does not deduct.** Ordering a tracked item moves no stock. Between placing and
   completing, the ledger says the ingredients are still there — because physically they may be.
2. **A cancelled order never deducts**, since it never reaches `completed`.
3. **The trigger reads `orders.items`**, the priced JSONB array — *not* `order_lines`. This matters
   for amendments; see §6.

The **sufficiency check is a separate, earlier thing** and must not be confused with deduction.
`check_stock_sufficiency_locked` runs at *placement* — `app/api/orders/route.ts`,
`app/api/terminal/orders/route.ts`, `app/api/terminal/rounds/route.ts`,
`lib/orders/apply-edit-additions.ts` — and refuses the sale. It is deliberately not in the trigger:
by completion the customer has already been served, so refusing there would strand the order
without un-cooking anything.

### What is deducted

For each line item, **only if both halves of the tracking state agree**:

- an `is_active`, non-tombstoned `recipes` row for that menu item, **and**
- `menu_items.track_inventory IS TRUE` (a NULL is *not* tracked)

then every `recipe_items` row deducts `quantity × line_quantity`, as `reason: 'sale'`,
`reference_type: 'order'`, `reference_id: <order id>`.

The two-sided requirement was added by `20260731230000` because unticking "Track inventory" used
to leave stock draining silently. **Today it means the opposite gap is possible and is live:**

- **38 menu items are flagged `track_inventory = true` with no active recipe.** The merchant sees
  "tracked"; nothing is ever deducted. The whole of Chownow Nedbank's coffee menu is in this set.
  The menu editor already badges these **🟠 Inventory Missing**, so the state is visible — it is
  simply not acted on.
- **26 active recipes sit on items not flagged tracked.** The recipe is dormant by design.

Neither is a code defect. Both are configuration, and both are listed for the merchant in §7.

---

## 3. Idempotency

```sql
IF EXISTS (SELECT 1 FROM stock_movements
           WHERE reference_type = 'order' AND reference_id = p_order_id)
THEN RETURN;
```

**The key is the order, and the guard is presence-of-any-movement.** So:

- Re-running the trigger, replaying the status change, or calling `deduct_recipe_stock` by hand is
  safe: the second run writes nothing.
- Concurrency is handled underneath it by `pg_advisory_xact_lock(hashtext(stock_item_id))`, taken
  **ordered by `stock_item_id`** so two orders sharing ingredients — or an order and a transfer —
  always lock in the same relative order and cannot deadlock (`20260719200000`).

### The known weakness in that guard

The function isolates a **per-line-item** exception into a `WARNING` and continues, so a partially
written deduction is possible in principle: lines 1 and 3 succeed, line 2 throws, and the
order-level guard then makes every future retry return immediately. Line 2 would be undeducted
forever, silently.

**Measured: this has never happened.** All 271 orders carrying sale movements were recomputed
against their recipes; **0 showed an ingredient missing entirely**. (76 orders differ in quantity,
every one of them in the "expected 0, actual −1" direction — tracking switched off or a recipe
changed *after* the sale. Historic movements correctly record what happened at the time and must
not be rewritten.)

So this is **exposure zero on a reachable path**, not a live defect. Fixing it means moving the
idempotency key from per-order to per-order-per-stock-item, which is a change to the money path
and is not made speculatively.

---

## 4. Retries

There is no application-level retry: nothing calls the function. A retry is either Postgres
replaying the statement or an operator re-running the status update, and both are covered by §3.

A failed deduction **cannot block order completion** — the exception handlers swallow into
`WARNING` precisely so a recipe misconfiguration cannot strand a served order. The cost is that a
failure is invisible outside the Postgres log.

---

## 5. Voids, cancellations and refunds — **RESOLVED, see §7**

### What happens today

**Nothing. There is no reversal path anywhere in the system.**

The `stock_movements.reason` CHECK allows `received, adjustment, loss, theft, recount, sale,
transfer_in, transfer_out` and the transfer reject/cancel reasons. **There is no `sale_reversal`,
no `void`, no `refund`.** No code writes a positive movement referencing an order.

| Event | Effect on stock today |
|---|---|
| Order cancelled before completion | Nothing was deducted. Correct. |
| Order cancelled *after* completion | Refused — `app/api/terminal/orders/[orderId]/status/route.ts:21` blocks cancelling a completed order. |
| Line voided before completion | See §6. |
| **Order refunded after completion** | **Stock stays deducted. No movement is written.** |

### Ruled 2026-09-01: that is correct, and it is now an invariant

"Stock stays deducted" is the answer. The food was made and served, the ingredients are gone, and
the customer got their money back — returning ingredients to inventory would overstate stock and
understate cost of sales.

The behaviour does not change; what changes is that it is now **decided and enforced** rather than
an accident of there being no code. See §7 R1/R2, and I2/I3 in
`__tests__/stock-consumption-invariants.test.ts`.

Also corrected in this pass: the row above claiming a completed order cannot be cancelled is true
of the TERMINAL route only. `cancelOrderWithTrail` filters on `payment_status`, not `status`, so a
completed-and-paid order is excluded in practice but not by that guard. One order has in fact been
cancelled after completion (`75cb3796`) and correctly kept its stock.

---

## 6. Amendments — a second-order case of §5

`amend_order_lines` (`20260829150000`) does **not** edit the original order. It voids lines on the
original and creates a **new** order carrying the replacement items.

The original order's `items` array is left whole — and `deduct_recipe_stock` reads `orders.items`.
So if an amended original order later completes, it deducts the **pre-amendment** quantity, and the
replacement order deducts its own quantity on top.

**Measured: exposure is zero.** Production holds **18 `order_lines` in total and not one voided
line, ever** (`order_line_events` shows only `null→outstanding`, `outstanding→cooked`,
`cooked→ready`, `outstanding→ready` — no void transition has ever been recorded). The waiter-led
flow that produces amendments is days old.

The fix depends on the §5 ruling — whether a void returns stock — so it is reported, not written.

---

## 7. RESOLVED — the owner's rulings, 2026-09-01

All four questions this document previously left open have been answered. They are now
**invariants**, pinned by `__tests__/stock-consumption-invariants.test.ts` (I1-I5).

### R1 — A refund does NOT restore stock

A financial refund does not imply physical inventory came back. The food was made and served; the
ingredients are gone. Refunding money is a payment event and has no inventory consequence.

Already true in code — there is no reversal path — so this ruling **changes nothing and enforces
everything**: I2's test refuses any future `sale_reversal` / `refund` / `void` reason in the
ledger vocabulary, and refuses any refund/cancel/void module that touches `stock_movements`.

### R2 — A void after completion does NOT restore stock by default

Inventory returns **only** through an explicit adjustment representing stock that genuinely came
back to usable inventory. It is never inferred from payment or order state.

The mechanism already exists and needs nothing new: `reason` accepts `adjustment`, `loss`,
`recount`. Food made but not sold is a `loss`; ingredients genuinely returned to the shelf are an
`adjustment`. Both are somebody's deliberate act, recorded with an actor, which is exactly what
"do not infer this" requires.

**This has already happened once and behaved correctly.** Order `75cb3796` was completed
2026-08-25 13:01 and cancelled 16:53 — nearly four hours later. Its sale movements are still in
the ledger. Under R2 that is the right outcome.

### R3 — Inventory does NOT control menu availability

`menu_items.status = 'out_of_stock'` stays merchant-controlled (the 2026-08-28 ruling stands).
Stock levels may WARN staff; they may not silently hide or unhide a dish.

Warning already exists and is untouched: `computeStockStatus` derives
`negative | out_of_stock | low_stock | healthy | not_tracked`, and the stock overview counts all
three attention states together. `check_stock_sufficiency_locked` still refuses a sale at
PLACEMENT, which is a refusal, not an availability change.

Newly enforced: **I5** — no module under `lib/stock` or `lib/recipes` may write a `status` key to
`menu_items`, and `deduct_recipe_stock` may not `UPDATE menu_items` at all.

### R4 — Tracked items without recipes are incomplete configuration

Never guessed. Excluded from automatic recipe-based deduction, and surfaced.

`lib/stock/inventory-configuration.ts` names the four states rather than collapsing them to a
boolean, because two of the four are faults that look like the third:

| state | deducts | meaning |
|---|---|---|
| `deducting` | yes | tracked **and** a live recipe with ≥1 ingredient |
| `tracked_without_recipe` | no | **the silent fault.** Every screen says tracked; nothing moves. |
| `recipe_without_tracking` | no | dormant by design since `20260731230000` |
| `not_tracked` | no | a merchant choice, not a fault — deliberately not reported |

An **empty** recipe counts as `tracked_without_recipe`, not as configured: it satisfies "a recipe
exists" while deducting precisely nothing, which is the exact shape that would report the silent
case as healthy.

Production, 2026-09-01: **38 `tracked_without_recipe`** (the whole of Chownow Nedbank's coffee
menu) and 26 `recipe_without_tracking`. Run
`node scripts/reports/merchant-configuration-report.mjs` for the current list.

---

## 7b. WHY `completed` IS THE RIGHT CONSUMPTION POINT

The brief required proving the point rather than inheriting it. The choice follows from R2:

| candidate | verdict |
|---|---|
| placed / accepted | Cancelled routinely, nothing made. Would deduct for food that never existed. |
| ready | Physically truest — the ingredients really are gone. But a ready order can still be cancelled, and under R2 nothing would put the stock back automatically, so each such case leaves a permanently wrong ledger no code may correct. It converts a rare event into an uncorrectable error. |
| **completed** | **Correct.** Every deduction corresponds to a completed sale. Food made but not sold is real waste, and the ledger already has the right word for it — an explicit `loss`, which is the mechanism R2 mandates. |

**Irreversibility, measured.** Of 2,573 production orders carrying a `completed_at`, exactly
**one** is no longer `completed` (`75cb3796`, above). Exactly-once does not depend on that anyway:
the trigger fires only on `OLD.status IS DISTINCT FROM 'completed'`, and the function returns early
if any movement already references the order, so re-entering completion deducts nothing further.

---

## 8. A documentation defect found while writing this

**`supabase/schema.sql` holds a stale copy of `deduct_recipe_stock`.** Its version has neither
`pg_advisory_xact_lock` nor the `track_inventory IS TRUE` gate — so anyone reading the schema dump
to understand deduction concludes that untracked items still deduct, which was true until
`20260731230000` and has been false since.

The authoritative definition is the **last migration that redefines the function**, currently
`20260801010000_recipes_soft_delete.sql` — a filename that gives no hint it contains it. The
contract test pins that and fails if a later migration takes over, so this document cannot quietly
start describing the wrong function.
