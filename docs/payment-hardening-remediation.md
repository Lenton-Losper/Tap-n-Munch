# Payment hardening — production remediation, deployment order, rollback

**Branch:** `fix/payment-hardening-sprint` (web), `fix/terminal-hardware-serial` (terminal)
**Web base:** `3a58efce81afa9676906068d282fa8178b22a773` (= `origin/main` at the time of writing)
**Terminal base:** `9426f990c2326fe51ce2f08bab11e2d9a936a181` (production 2.37 / versionCode 138)
**Written:** 2026-09-19

Nothing in this document has been applied. Every figure in it was measured against production
read-only, inside `BEGIN READ ONLY … ROLLBACK`, on 2026-09-19.

---

## 0. The rule this document exists to enforce

**No production data is corrected by code in this sprint.** Every anomaly below is either left
exactly as it is, or corrected by a SQL statement a human runs deliberately, having read why.

That is not caution for its own sake. Three of the five anomaly classes below are *unresolved
payments*, and the one thing that must never happen to an unresolved payment is an automatic
decision: an E04111 from this gateway means **no record**, never **not paid**, so auto-settling is
a free meal and auto-failing takes a real charge twice. The ruling is from 2026-09-06 and this
sprint does not weaken it — `lib/payments/reconciliation.ts` has no writer at all, and
`app/api/platform/payments/reconciliation/route.ts` exposes `GET` only.

---

## 1. Production anomalies

### 1.1 Riviera #154 — a real, unpaid N$220

**What happened.** Settlement `4158ff51-2468-4bdf-a8d0-57947ab173dc`, 2026-09-18 16:37:39 UTC.
Orders #154 (N$220) and #155 (N$500) were one card charge of N$720. Finatic confirmed N$720. The
webhook verified N$720 against both orders and applied payment to #155 alone.

```
order #155   payment_status = paid,    total = 500
order #154   payment_status = pending, total = 220
audit_logs   action = payment.completed, entity_id = <#155>,
             metadata.gatewayAmount = 720, source = paycloud_webhook_fallback_finatic_verified
```

This is the only multi-order settlement production has ever recorded. It failed.

**Do not fix it with the code.** #154 is `pending`, so the next legitimate settlement on that tab
would claim it and charge the customer a second time for money already collected. It needs a
deliberate correction.

**Before running anything, confirm with Finatic that N$720 was captured** against the merchant
order number on #155. The correction below asserts that the money arrived; if it did not, the
correct action is the opposite one.

```sql
-- READ FIRST. Confirm the shape has not moved since 2026-09-19.
SELECT id, order_number, payment_status, payment_method, total, paid_at,
       paycloud_merchant_order_no, pending_settlement_id
  FROM public.orders
 WHERE pending_settlement_id = '4158ff51-2468-4bdf-a8d0-57947ab173dc'
 ORDER BY order_number;
-- EXPECT exactly two rows: #154 pending N$220, #155 paid N$500.

-- THEN, in one transaction, having confirmed the capture with Finatic:
BEGIN;

UPDATE public.orders
   SET payment_status     = 'paid',
       status             = 'completed',
       payment_method     = 'card',
       -- The SAME reference as #155: it was one charge, and two references would make it look
       -- like two payments to every reconciliation that runs afterwards.
       payment_reference  = (SELECT payment_reference FROM public.orders
                              WHERE order_number = 155
                                AND pending_settlement_id = '4158ff51-2468-4bdf-a8d0-57947ab173dc'),
       paid_at            = (SELECT paid_at FROM public.orders
                              WHERE order_number = 155
                                AND pending_settlement_id = '4158ff51-2468-4bdf-a8d0-57947ab173dc'),
       completed_at       = now(),
       pending_charge_cents      = NULL,
       pending_tip_cents         = 0,
       pending_tip_staff_user_id = NULL,
       pending_settlement_id     = NULL
 WHERE order_number = 154
   AND pending_settlement_id = '4158ff51-2468-4bdf-a8d0-57947ab173dc'
   -- Belt and braces: refuse if somebody has already settled it.
   AND payment_status = 'pending';

-- The audit trail must say a human did this, and why. An unexplained status change on a money
-- row is indistinguishable from a defect when somebody reads it in six months.
INSERT INTO public.audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
SELECT o.restaurant_id,
       'payment.manual_correction',
       'order',
       o.id::text,
       jsonb_build_object(
         'reason', 'Riviera settlement 4158ff51: one N$720 card charge covered #154 and #155; '
                || 'the webhook applied payment to #155 alone. Corrected by hand after '
                || 'confirming the capture with Finatic.',
         'settlement_id', '4158ff51-2468-4bdf-a8d0-57947ab173dc',
         'gateway_amount', 720,
         'covered_orders', ARRAY[154, 155],
         'corrected_by', '<operator name>',
         'defect', 'webhook verified settlementRows and wrote orderRows')
  FROM public.orders o
 WHERE o.order_number = 154
   AND o.paid_at IS NOT NULL;

-- Also clear #155's now-consumed settlement grouping, so the pair does not re-expand.
UPDATE public.orders
   SET pending_settlement_id = NULL, pending_charge_cents = NULL
 WHERE order_number = 155
   AND pending_settlement_id = '4158ff51-2468-4bdf-a8d0-57947ab173dc';

-- VERIFY BEFORE COMMITTING.
SELECT order_number, payment_status, payment_method, paid_at, payment_reference
  FROM public.orders WHERE order_number IN (154, 155);

COMMIT;  -- or ROLLBACK if the two rows do not read as expected
```

**The ledger row is a separate question.** This settlement has no `payment_events` sale row (it
predates the server-side writer). Adding one by hand would assert a transaction id nobody has
verified. Leave it; the reconciliation report classifies it `gateway_success_missing_ledger`,
which is exactly what it is.

### 1.2 Paid-and-cancelled contradictions (4 rows)

```
3 rows   payment_status = 'paid' AND status = 'cancelled'
         #456, #500, #546 — all restaurant b161c758, all 2026-07-24
1 row    payment_status = 'paid' AND cancelled_at IS NOT NULL
         #377 — cancellation_reason 'auto_timeout', paid_at 324 ms after cancelled_at
```

All four predate `markOrderPaidConfirmed`'s clearing of `cancelled_at`/`cancellation_reason`,
which is why no new row has joined them since.

**These are not urgent and must not be swept.** They are historical, the money question is
settled (they are paid), and the only thing wrong is that two columns disagree about the order's
lifecycle. A blanket `UPDATE … SET status='completed'` would also rewrite any row that legitimately
arrives in that state later.

`orderContradictions()` in `lib/payments/payment-state-machine.ts` names each one, so they are
findable. Correct them individually, by order number, once somebody has decided what each should
read:

```sql
-- Confirm the four are still the four.
SELECT id, order_number, restaurant_id, status, payment_status, cancelled_at, cancellation_reason,
       paid_at, total
  FROM public.orders
 WHERE payment_status = 'paid'
   AND (status <> 'completed' OR cancelled_at IS NOT NULL)
 ORDER BY paid_at;

-- Per row, once decided. NEVER as a set.
BEGIN;
UPDATE public.orders
   SET status = 'completed', cancelled_at = NULL, cancellation_reason = NULL
 WHERE order_number = <n> AND restaurant_id = '<uuid>' AND payment_status = 'paid';
INSERT INTO public.audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
VALUES ('<uuid>', 'payment.manual_correction', 'order', '<order uuid>',
        jsonb_build_object('reason', 'paid order left with a cancelled lifecycle status',
                           'corrected_by', '<operator>'));
COMMIT;
```

### 1.3 `verification_uncertain` — 292 orders, N$25,856

```
572 audit rows, 336 distinct orders
  154 orders still pending    N$16,874
  138 orders cancelled        N$8,982
   37 orders since paid       N$3,201
```

**Do not resolve these in bulk, in either direction.** Each one is a payment whose state was never
established. Settling them all marks paid whatever was never charged; cancelling them all discards
whatever was.

The procedure is per order and starts at the gateway, not at the database:

1. `GET /api/platform/payments/reconciliation?category=verification_uncertain` for the list, with
   each order's merchant order number.
2. For each, query Finatic directly for that reference.
3. **Paid at the gateway** → apply the correction in §1.1's shape, with the gateway's own amount.
4. **Not paid at the gateway** → leave it. A pending order is not costing anybody anything, and
   cancelling it destroys a claim on money for no gain.
5. **E04111 (no record)** → leave it and re-check later. #149 answered E04111 and was confirmed
   paid on the same reference 22 seconds afterwards; the 72-hour persistence rule exists for this.

### 1.4 331 paid card orders with no merchant reference (F17)

```sql
SELECT count(*) FROM public.orders
 WHERE payment_status='paid' AND payment_method='card'
   AND (paycloud_merchant_order_no IS NULL OR btrim(paycloud_merchant_order_no)='');
-- 331 on 2026-09-19
```

**Do not invent references.** A fabricated `business_order_no` produces a ledger row that matches
no Finatic transaction and *looks reconciled*, which is strictly worse than the gap.

They are surfaced as `missing_merchant_reference` by the reconciliation report. Classify them —
historical pre-gateway orders, legitimate non-Finatic card payments, or genuine failures — before
deciding anything. Most are likely to be the first: the merchant order number was introduced part
way through the system's life.

### 1.5 435 unpaid orders with a stale `pending_charge_cents` (F18)

```
263 cancelled   oldest 2026-09-07, newest 2026-09-18
172 pending     oldest 2026-09-07, newest 2026-09-18
```

The code now clears the expectation at the two points where an attempt is definitively over:
successful settlement (inside `settle_order_payment`) and staff cancelling a card attempt
(`/api/payments/cancel-terminal`).

**It is deliberately NOT cleared on order cancellation**, and this is the part worth reading
before anybody "tidies up" the backlog: an order auto-cancelled on E04111 evidence can still be
recovered by a later webhook, and that recovery compares the gateway's figure against this
expectation. Clearing it would fall back to the order total and **refuse a tipped payment that
actually succeeded**.

So the 263 cancelled rows stay as they are. The 172 pending rows can be cleared once each has been
resolved through §1.3, at which point the attempt is genuinely over.

### 1.6 Duplicate terminal registration `WPYB002452000261` (F19)

```
sn = 'WPYB002452000261'   two rows, one physical P5
  d69cf493-7070-4ce2-974e-5f310ce922df   device_serial aa8168fab9b87b2d   2026-06-17 23:27:34Z
  1c7deb8d-abd2-467f-9583-ba75af7bf93b   device_serial d65e2c61ceefa734   2026-06-17 23:57:17Z
  both restaurant 01bf27f1-a958-4322-bb3e-cc5240987808, both status 'active', neither activated_at
```

Both are from the same manual seed batch, 30 minutes apart, and neither was ever activated
(`activated_at IS NULL`).

**Establish which row, if either, has ever transacted before touching anything:**

```sql
SELECT terminal_id, count(*) AS events, min(created_at), max(created_at)
  FROM public.payment_events
 WHERE terminal_id IN ('d69cf493-7070-4ce2-974e-5f310ce922df',
                       '1c7deb8d-abd2-467f-9583-ba75af7bf93b')
 GROUP BY 1;

SELECT metadata->>'terminal_id' AS terminal_id, count(*)
  FROM public.audit_logs
 WHERE metadata->>'terminal_id' IN ('d69cf493-7070-4ce2-974e-5f310ce922df',
                                    '1c7deb8d-abd2-467f-9583-ba75af7bf93b')
 GROUP BY 1;
```

If one row has no history at all, **revoke** it rather than deleting it — a deleted registration
takes any future audit reference with it:

```sql
BEGIN;
UPDATE public.restaurant_terminals
   SET active = false, status = 'revoked', refresh_token_hash = NULL
 WHERE id = '<the row with no history>'
   AND sn = 'WPYB002452000261';
INSERT INTO public.audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
VALUES ('01bf27f1-a958-4322-bb3e-cc5240987808', 'terminal.duplicate_revoked',
        'restaurant_terminal', '<id>',
        jsonb_build_object('sn', 'WPYB002452000261',
                           'kept', '<the other id>',
                           'reason', 'two registrations of one physical P5 from the 2026-06-17 seed',
                           'revoked_by', '<operator>'));
COMMIT;
```

**Only after the duplicate is resolved** may a uniqueness constraint be added. It is deliberately
not in this sprint's migrations, because it would fail on today's data:

```sql
-- NOT part of 20260919091000. Run it only once the duplicate above is gone.
CREATE UNIQUE INDEX CONCURRENTLY restaurant_terminals_sn_unique
    ON public.restaurant_terminals (sn)
 WHERE sn IS NOT NULL AND btrim(sn) <> '';
```

### 1.7 The 1,630 card orders with no ledger row (F2)

N$110,027 of paid card orders with no `payment_events` sale row. **Nothing is backfilled.** A
backfilled sale row would carry an amount taken from the order rather than from the gateway, and a
`business_order_no` that may not correspond to any real transaction — which turns an honest gap
into a dishonest reconciliation.

The server-side writer stops the gap growing from the deploy onward. The existing rows stay
visible as `gateway_success_missing_ledger`, and the only way to close them properly is a Finatic
statement reconciliation, which needs the acquirer's data and not ours.

---

## 2. Migrations

Four, all idempotent, all applied via direct Postgres (CI has no DDL credentials).

| File | What it does | Locks | Reversible |
|---|---|---|---|
| `20260919090000_settle_order_payment_atomic.sql` | adds 5 nullable columns to `terminal_payment_intents`; creates `settle_order_payment()` | `ADD COLUMN … IF NOT EXISTS` with no default — metadata-only | yes, see §4 |
| `20260919091000_payment_integrity_constraints.sql` | 3 unique indexes, drops 2 redundant ones, 1 CHECK added `NOT VALID` then validated | index builds (not `CONCURRENTLY` — see below); `VALIDATE` takes `SHARE UPDATE EXCLUSIVE` | yes, see §4 |
| `20260919092000_settle_lead_merchant_order_no.sql` | `CREATE OR REPLACE` of the same function: only the LEAD order takes `paycloud_merchant_order_no` | none | yes — replace with the prior definition |
| `20260919093000_settle_validate_before_write.sql` | `CREATE OR REPLACE` again: every transition is checked BEFORE the first write | none | yes — replace with the prior definition |

### 2.1 Why 092000 and 093000 exist

Both close defects in 090000 that the local Docker harness could not see and the STAGING DATABASE
found within minutes of the first smoke run. Both are in this sprint's own code; neither has ever
run on production.

**092000 — a multi-order settlement could not commit at all.** The claim loop wrote
`paycloud_merchant_order_no` on every order it paid. `orders_paycloud_merchant_order_no_unique` is a
GLOBAL partial unique index (20260502120000), so the second order of any settlement raised 23505 and
the whole transaction rolled back: card charged, nothing recorded. The index's own migration already
stated the rule — *"table receipts share payment_reference; only the lead row holds
paycloud_merchant_order_no"* — and the function did not honour it.

The harness missed it because `supabase/tests/fixture-schema.sql` did not carry that index. It does
now, and mutation **M11** puts the defect back and requires the suite to go red.

**093000 — a refused settlement could leave an order paid.** `RETURN` in plpgsql ends the
function, not the transaction. The claim loop checked each order's transition as it went and
returned on the first illegal one, under a comment claiming that returning rolled back every write
above it. It never did. Measured on staging, one legal order settled together with one cancelled
one, ids chosen so the sort order differed:

| target locked `ORDER BY id` | returned | legal order |
|---|---|---|
| legal order's id sorts FIRST | `illegal_transition`, `claimed=[]` | **PAID** |
| legal order's id sorts LAST | `illegal_transition`, `claimed=[]` | untouched |

So the caller was told the settlement was refused while a customer's order had been marked paid,
with no `payment_events` row and no audit row naming it — the partial application this function
exists to make unreachable, reached through the code meant to prevent it.

`_t_illegal_transition_is_atomic` asserted exactly this and PASSED, because its two fixture ids
happened to sort the safe way round. Both orderings are now asserted, and mutation **M12** removes
the pre-write validation and requires the reversed-ordering assertion to fail.

---

**Data compatibility, each verified read-only before the constraint was written:**

| Constraint | Blocking rows on production |
|---|---|
| `orders_restaurant_idempotency_key_unique` | 0 — 4,445 non-null keys, no value appears twice |
| `order_line_allocation_settlements_one_per_allocation` | 0 — 16 rows, no allocation settled twice |
| `payment_events_restaurant_transaction_id_unique` | 0 — 3,187 rows, no null/blank txn id, no duplicate pair |
| `orders_payment_status_enumerated` | 0 — three distinct values present, all inside the nine |

**The index builds are not `CONCURRENTLY`.** At 6,598 orders and 3,187 events they take well under
a second and a brief `SHARE` lock is acceptable. If these tables are materially larger when this is
run, convert them: `CREATE UNIQUE INDEX CONCURRENTLY` cannot run inside a transaction, so the
migration would have to be split.

**Migration lint / ledger.** `supabase db query` does not write the `schema_migrations` row, so the
next deploy's drift gate fails after a perfectly successful apply. Apply through the direct-Postgres
path that writes the DDL and the ledger row in one transaction, and confirm
`git ls-files --error-unmatch <file>` succeeds before applying — an untracked `.sql` must never
reach production.

---

## 3. Deployment order

The order matters in two places, and both are one-directional.

```
1. WEB CODE  (fix/payment-hardening-sprint)
   Deploy first, with no migration.

   WHY FIRST. lib/orders/create-order.ts and app/api/orders/route.ts now scope their
   23505-recovery lookups by restaurant_id. Under the CURRENT global index that filter is
   redundant and harmless. Under the NEW composite index it is what stops a .single()
   returning another venue's order. Deploying the migration first is the one ordering
   that breaks.

   Everything else in this deploy is additive and degrades to today's behaviour:
     - settle_order_payment does not exist yet, so settleWholeOrderPayment's RPC call
       errors and returns { ok: false, reason: 'rpc_failed' }, which is RETRYABLE — the
       webhook answers 503 and Finatic retries. NO PAYMENT IS LOST, but settlements will
       not apply until step 2. Keep this window SHORT, or do steps 1 and 2 back to back.

2. MIGRATION 20260919090000  (the RPC + intent columns)
   Settlements start applying. Verify with a probe (§5) before moving on.

3. MIGRATIONS 20260919092000 then 20260919093000  (the two corrections to the function)
   MANDATORY, and immediately after step 2. Each is a CREATE OR REPLACE of the function
   step 2 created, so 090000 alone is NOT a shippable state: on its own it cannot settle a
   multi-order tab at all, and it can leave an order paid by a settlement it refused.
   Applying all three back to back is the intended sequence; 090000 is separate only
   because it is already applied on staging and rewriting an applied file hides drift.

4. MIGRATION 20260919091000  (the integrity constraints)
   Safe at any point after step 1. Separated only so a failure is attributable.

5. TERMINAL 2.38 / versionCode 139  (fix/terminal-hardware-serial)
   INDEPENDENT of 1–3 and can go at any time, including never. It needs no server change:
   /api/terminals/activate has always accepted `sn` and `device_id`.
   It only affects terminals activated AFTER install — existing registrations are unchanged.

6. restaurant_terminals_sn_unique
   ONLY after §1.6's duplicate is resolved. Not part of any migration file.
```

**What does NOT need to be coordinated:** the terminal build. Nothing in web steps 1–4 requires a
terminal change, and the terminal change requires nothing on the server. They are separable
deployments and should be done separately.

---

## 4. Rollback

| Step | How to roll back | Data loss |
|---|---|---|
| 1. Web code | Redeploy the previous worker version. | None. |
| 2. RPC migration | `DROP FUNCTION public.settle_order_payment(...)`. The five intent columns are nullable and can be left — they are additive and nothing reads them once the function is gone. | None. Settlements revert to the previous behaviour, **including the Riviera defect**. |
| 3. Constraints | Drop each index / constraint, then recreate the two old idempotency indexes. Statements below. | None. |
| 4. Terminal | Install the previous APK (2.37 / 138). | None. Serials already recorded stay recorded. |

```sql
-- Step 3 rollback, in full.
DROP INDEX IF EXISTS public.orders_restaurant_idempotency_key_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key
    ON public.orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
DROP INDEX IF EXISTS public.order_line_allocation_settlements_one_per_allocation;
DROP INDEX IF EXISTS public.payment_events_restaurant_transaction_id_unique;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_status_enumerated;
```

**Rolling back step 1 while step 2 is applied is safe** — the old code never calls the RPC.
**Rolling back step 2 while step 1 is deployed is the bad combination**: settlements stop applying
and every webhook answers 503. Finatic retries rather than discarding, so nothing is lost, but it
must not be left in that state.

**The one irreversible thing in this sprint is the dropped indexes in step 3**, and only in the
sense that recreating a *global* unique index would now fail if two venues had meanwhile used the
same idempotency key. The rollback above recreates one of the two; if it fails, that is why, and
the composite index is the correct state to stay in.

---

## 5. Post-deploy verification

Read-only, in order. Each is a question with a wrong answer that means "stop".

```sql
-- 1. The function exists and only service_role can call it.
SELECT has_function_privilege('anon', 'public.settle_order_payment(uuid, uuid[], integer, integer,
  text, text, text, text, uuid, text, text, integer, uuid, uuid[], text)', 'EXECUTE')        AS anon_can,
       has_function_privilege('authenticated', 'public.settle_order_payment(uuid, uuid[], integer,
  integer, text, text, text, text, uuid, text, text, integer, uuid, uuid[], text)', 'EXECUTE') AS auth_can,
       has_function_privilege('service_role', 'public.settle_order_payment(uuid, uuid[], integer,
  integer, text, text, text, text, uuid, text, text, integer, uuid, uuid[], text)', 'EXECUTE') AS svc_can;
-- EXPECT false, false, true. Anything else: stop and fix the grants.

-- 2. Settlements are applying to their whole target set.
SELECT entity_id,
       metadata->>'settlement_order_count'  AS orders,
       metadata->'intended_order_ids'       AS intended,
       metadata->'applied_order_ids'        AS applied,
       metadata->'intended_order_ids' = metadata->'applied_order_ids' AS sets_match
  FROM public.audit_logs
 WHERE action = 'payment.settlement_applied'
 ORDER BY created_at DESC LIMIT 20;
-- EXPECT sets_match = true on every row. A false is the Riviera defect returning.

-- 3. The ledger gap has stopped growing.
SELECT count(*) FROM public.orders o
 WHERE o.payment_status='paid' AND o.payment_method='card'
   AND o.paid_at > '<the deploy timestamp>'
   AND NOT EXISTS (SELECT 1 FROM public.payment_events pe
                    WHERE pe.event_type='sale' AND pe.order_ids @> ARRAY[o.id]);
-- EXPECT 0. A non-zero count means the server-side writer is not running.

-- 4. No card payment is recorded under a non-card method.
SELECT count(*) FROM public.orders
 WHERE payment_status='paid' AND payment_method <> 'card'
   AND paycloud_merchant_order_no IS NOT NULL
   AND paid_at > '<the deploy timestamp>';
-- EXPECT 0.
```

And, from the application side:
`GET /api/platform/payments/reconciliation?since=<deploy timestamp>` — the `critical` count for
orders placed after the deploy should be zero.

---

## 6. What this sprint deliberately did not do

- **No production data was modified.** Everything in §1 is a statement for a human to run.
- **No deploy, no merge, no push.** Both branches are local.
- **`tabs.total` was not dropped.** It still has writers and non-financial readers; the column is
  kept in step by `settle_order_payment` so it does not go stale while it exists. It is no longer
  authoritative for anything, which is the part that mattered.
- **`payment_events.order_ids` was not normalised** to a junction table. The containment query is
  already served by a GIN index, no invariant in this sprint needs the join, and two large changes
  to one table in one release make a regression unattributable.
- **No unique index on `restaurant_terminals.sn`** — today's data would block it. See §1.6.
- **No sweeper for uncertain payments.** By ruling, and the reconciliation module has no writer.
