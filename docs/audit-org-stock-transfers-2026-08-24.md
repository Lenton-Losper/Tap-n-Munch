# Audit — organisation stock transfers

Read-only. Nothing changed. 2026-08-24.

**It has never run.** Zero rows in `stock_transfers`, zero in `stock_transfer_items`, and zero
`transfer_out` / `transfer_in` rows in `stock_movements` on production. Every finding below is from
reading the code and the schema, plus what production data can say about whether a transfer *could*
succeed today.

---

## 1. The flow, and what each step does to stock

```
DRAFT ──dispatch──> IN_TRANSIT ──receive──> RECEIVED
  │
  └──cancel──> CANCELLED
```

| step | stock at source | stock at destination | function |
|---|---|---|---|
| create | — | — | `create_transfer` |
| **dispatch** | **−`quantity_sent`** (`transfer_out`) | — | `dispatch_transfer` |
| **receive** | — | **+`quantity_received`** (`transfer_in`) | `receive_transfer` |
| cancel | — | — | `cancel_transfer` |

**There is no reject.** The status vocabulary is `CHECK (status IN ('DRAFT','IN_TRANSIT','RECEIVED','CANCELLED'))`
— a destination that does not want a delivery has no action available to it.

**Cancel works only from DRAFT.** `cancel_transfer` raises otherwise:

```sql
IF v_transfer.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'transfer % can only be cancelled while DRAFT (status=%)', ...
```

So a DRAFT cancel is a pure status change with no stock to return, which is correct — and **once
dispatched, a transfer cannot be cancelled at all.**

---

## 2. Atomicity — each step is atomic, the transfer is not

Each of `dispatch_transfer`, `receive_transfer` and `cancel_transfer` is a single PL/pgSQL function,
so each runs in one transaction and cannot half-apply. Dispatch takes `FOR UPDATE` on the transfer
row. **Within a step, stock cannot vanish or duplicate.**

**The transfer as a whole is two-phase and is NOT atomic.** Dispatch and receive are separate
transactions initiated by different people at different locations, with an unbounded window between
them. During that window the stock has been deducted from the source and not added anywhere:

> ### In-transit stock exists at no location. It is not "at" the source, and not yet "at" the destination.

That is a legitimate modelling choice for goods physically in a van. What makes it a risk here is
that **there is no way out of the window except forward.**

### The permanent strand

`dispatch_transfer` verifies a destination mapping exists before deducting. `receive_transfer`
re-checks it and raises if it has gone:

```sql
RAISE EXCEPTION 'defect: destination stock_items mapping for organization_stock_item % missing at
receive time (restaurant %) -- was confirmed to exist at dispatch'
```

If that mapping is deleted or deactivated between dispatch and receive:

- **receive** raises — the goods cannot be booked in
- **cancel** raises — it only accepts DRAFT
- the transfer is stuck `IN_TRANSIT` **permanently**, and the deducted stock is gone from the books
  with no recovery path short of a manual `stock_movements` insert

The exception text calls this a `defect:` and says the mapping *was confirmed to exist at dispatch*
— so the author saw the window. **What is missing is the remedy, not the detection.**

### Variance quietly destroys stock

`receive_transfer` accepts `quantity_received < quantity_sent` with a `variance_reason`. The
shortfall is **not** returned to the source and **not** recorded as a loss anywhere except that free-text
reason. Send 10, receive 8, and two units leave the organisation's books with no movement row of
their own. Defensible as shrinkage; worth deciding deliberately rather than inheriting.

---

## 3. Canonical item identity — by id, not by name

**Items are matched by `organization_stock_item_id`, not by name.** Each location's `stock_items` row
carries a nullable `organization_stock_item_id` pointing at the org-level canonical item, and
`dispatch_transfer` resolves both ends through it, raising if either is missing:

```sql
RAISE EXCEPTION 'organization_stock_item % has no active stock_items mapping at source restaurant %'
RAISE EXCEPTION 'organization_stock_item % has no active stock_items mapping at destination restaurant %'
```

This is the right design and it is the part I would have most expected to be wrong. **A name
collision cannot cause a mis-transfer, and a rename cannot break one.**

The cost is that a transfer is only possible for items mapped at **both** ends — see §6, where that
turns out to be the binding constraint in production today.

---

## 4. Who can initiate, and can stock be pushed into a location?

Three distinct permissions:

```
stock:transfer_create     create a draft to another location
stock:transfer_dispatch   dispatch out of this location
stock:transfer_receive    receive into this location
```

**A transfer cannot complete without the destination acting** — `receive_transfer` is the only thing
that books stock in, and the panel that calls it requires `STOCK_TRANSFER_RECEIVE` at the
destination. So no location can be force-fed inventory.

**But the source can push stock out unilaterally.** Create and dispatch are both source-side rights.
The destination's only power is refusal-by-inaction, and refusing does not return the stock — it
strands it (§2). **There is no "return to sender".**

### The permission checks live in TypeScript, not in SQL

`lib/stock/transfer-actions.ts` calls `authorize` / `authorizeOrganization`. The SQL functions
contain **zero** permission checks and take a caller-supplied `p_user_id`, which they trust blindly.
They are `SECURITY DEFINER`, so they bypass RLS.

**This was exploitable and has been closed.** `20260727140000` records that on staging an anon-key
client *"cancelled a real cross-tenant stock transfer"* by calling the function directly through
PostgREST — the project auto-grants EXECUTE on new public functions to `anon`/`authenticated`, so the
original `REVOKE ALL FROM PUBLIC` did nothing. The sweep revokes explicitly:

```sql
REVOKE EXECUTE ON FUNCTION public.dispatch_transfer(uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.receive_transfer(uuid, uuid, jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cancel_transfer(uuid, uuid)  FROM anon, authenticated;
```

**Verified applied on production** — `20260727140000` is in the ledger, along with all nine transfer
migrations. Only `service_role` can call them now, which means the TypeScript check is genuinely the
only door. That is sound *as long as it stays that way*: the functions themselves would still trust
anyone who reached them.

---

## 5. Audit trail

- **A completed transfer leaves a trail**: `transfer_out` and `transfer_in` rows in `stock_movements`,
  plus `dispatched_by` / `dispatched_at` / `received_by` / `received_at` on the transfer, and
  `quantity_received` / `variance_reason` per item.
- **A cancellation leaves nothing to survive**, and correctly so — cancel is DRAFT-only, and a DRAFT
  has produced no stock movement. The row remains with `status = 'CANCELLED'`.
- **A rejection has no trail because there is no rejection.** An unwanted delivery is represented by
  a transfer sitting in `IN_TRANSIT` indefinitely, which is indistinguishable from one still in the
  van.

---

## 6. What production data says

**No transfer has ever been attempted.** No stranded rows, because there are no rows.

```
stock_transfers           0
stock_transfer_items      0
stock_movements  transfer_out=0  transfer_in=0
organizations            12
organization_stock_items 51
```

**Eleven of twelve organisations have exactly one location**, so a transfer is impossible for them —
the schema requires `from_restaurant_id != to_restaurant_id`. Only one org can transfer at all:

**Gosto Investment CC** — Riviera, FNB ChowNow, Chownow Nedbank.

| from → to | canonical items mapped at both ends |
|---|---|
| FNB ChowNow → Chownow Nedbank | **8** |
| Chownow Nedbank → FNB ChowNow | **8** |
| Riviera → FNB ChowNow | **0 — would fail** |
| Riviera → Chownow Nedbank | **0 — would fail** |
| FNB ChowNow → Riviera | **0 — would fail** |
| Chownow Nedbank → Riviera | **0 — would fail** |

**Four of the six ordered pairs cannot transfer anything today.** Riviera has 2 stock items mapped to
canonical items and the other two locations have 8 each, with **no overlap**. Any Riviera transfer
fails at dispatch with `has no active stock_items mapping at destination restaurant`.

That failure is **safe** — it raises before deducting, so nothing is lost. But it is a wall the first
user will hit, and the message names a `organization_stock_item` UUID rather than an item name.

---

## 7. What I could not establish

Stated as unestablished rather than inferred.

- **Whether the UI reaches every branch.** I read `create-transfer-form`, `incoming-transfers-panel`,
  `outgoing-transfers-panel`, `organization-transfers-panel` and `transfer-history-panel` by name
  only. I did not trace which permission each panel checks, and I did not click-test anything.
- **Concurrency between two dispatches of the same item.** `dispatch_transfer` takes `FOR UPDATE` on
  the *transfer* row, and computes availability with `SUM(quantity_delta)` over `stock_movements`.
  Whether two concurrent dispatches of different transfers drawing the same item can both pass the
  availability check is **not established** — there is a separate advisory-lock migration for recipe
  deduction (`20260719200000`), which suggests this class was considered somewhere, but I did not
  confirm it covers dispatch.
- **Whether the destination can see a transfer before receiving it.** RLS reads
  `stock_transfers` by restaurant-or-organisation, but I did not verify that an incoming transfer is
  visible to destination staff who lack org-level rights.
- **What reporting does with in-transit stock.** Whether any report counts it, double-counts it, or
  ignores it is unknown.
- **Whether `receive_transfer` can be called for a transfer whose destination is not the caller's
  location.** The SQL does not check it; the TypeScript is presumed to, but I did not read that path
  closely enough to assert it.

---

## 8. Cross-cutting note

**Chownow Nedbank is one of the two locations with 8 transferable items, and it cannot take a card**
— it has no `finatic_merchant_no` / `finatic_store_no`, and with #107 closed the fallback is the only
settlement path and it throws without credentials. So the location most ready to receive stock is the
one least ready to sell it.
