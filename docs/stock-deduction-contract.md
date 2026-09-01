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

## 5. Voids, cancellations and refunds — **THE OPEN DECISION**

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

### Why this is a decision and not a bug

For a refund, "stock stays deducted" is very likely **correct**: the food was made and served, the
ingredients are gone, and the customer got their money back. Returning ingredients to inventory
would overstate stock and understate cost of sales.

But it is a *choice*, and nothing records that it was ever made. The opposite reading — a refund
means the sale did not happen, so the stock should come back — produces different inventory
valuation and different COGS. **That is an accounting decision, not an engineering one**, so this
sprint stops here rather than encoding an answer.

**What is needed from the owner:** see §7.

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

## 7. What the owner has to decide

Nothing below is implemented. Each changes inventory valuation or cost of sales.

1. **Does a refund on a completed order return stock?**
   Recommended: **no** — the food was made and served. Encode it explicitly so the answer stops
   being an accident of there being no code.
2. **Does voiding a line on a completed order return stock?**
   This is the one that actually needs thought: the kitchen may or may not have made it. The
   station states already distinguish those cases (`outstanding` vs `cooked`/`ready`), so the
   system *can* tell "cancelled before we started" from "cancelled after it was plated" — but
   only if someone rules on which of those returns stock.
3. **Should the ledger drive menu availability?**
   Today `menu_items.status = 'out_of_stock'` is a **manual merchant state** (ruled 2026-08-28:
   shown, greyed, Add disabled — so a QR customer still learns the dish exists). A tracked item
   whose ingredients hit zero stays orderable and is refused at checkout with a 409. Wiring the
   ledger to availability would overrule that decision, so it needs a new one.
4. **The 38 tracked-but-unconfigured items.** Not code. Either configure recipes or untick
   tracking; today they are badged 🟠 and deducting nothing.

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
