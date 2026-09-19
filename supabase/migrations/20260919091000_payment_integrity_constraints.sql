-- @env: both
--
-- DATABASE-ENFORCED FINANCIAL INVARIANTS.
--
-- Every constraint here was checked against PRODUCTION DATA before being written, read-only, on
-- 2026-09-19. The counts are recorded beside each one: a constraint that would fail on existing
-- rows is not "safe because it should be true", and the brief's instruction not to add a CHECK
-- until the existing values are enumerated applies to all four.
--
-- ==================================================================================================
-- WHAT WAS MEASURED
-- ==================================================================================================
--
--   orders                            6,598 rows; 4,445 with a non-null idempotency_key;
--                                     ZERO idempotency_key values appearing more than once
--   order_line_allocation_settlements 16 rows; ZERO allocations settled more than once
--   payment_events                    3,187 rows; ZERO null-or-blank transaction_id;
--                                     ZERO duplicate (restaurant_id, transaction_id)
--   orders.payment_status             three distinct values: paid 5,389 / cancelled 933 /
--                                     pending 276
--
-- Each constraint is therefore satisfied by production as it stands today, and each is created
-- NOT VALID first where a full-table validation would take a long lock -- see the notes inline.

-- --------------------------------------------------------------------------------------------
-- F12. orders.idempotency_key: restaurant-scoped, not global.
-- --------------------------------------------------------------------------------------------
--
-- Production carries TWO identical global partial-unique indexes on this column --
-- `idx_orders_idempotency_key` and `orders_idempotency_key_unique` -- one of which has been pure
-- duplicate maintenance cost since whichever migration added the second.
--
-- Global uniqueness on a per-tenant idempotency key is wrong in a way that only ever bites in one
-- direction: two venues that happen to generate the same key (a client-supplied string, or the
-- `order-request-accept:<uuid>` shape) collide, and the LOSER'S ORDER IS REJECTED as a duplicate
-- of a different restaurant's. It has not happened -- zero duplicate values exist -- which is
-- exactly why it is safe to fix now rather than after it does.
--
-- THE CODE CHANGE MUST SHIP FIRST, and it has. `lib/orders/create-order.ts` and
-- `app/api/orders/route.ts` recover from a 23505 by re-reading the row by key; both now also
-- filter on restaurant_id. Under the old index that filter is redundant; under this one it is what
-- stops a `.single()` returning another venue's order. Deploying this migration ahead of that code
-- is the one ordering that breaks.

CREATE UNIQUE INDEX IF NOT EXISTS orders_restaurant_idempotency_key_unique
  ON public.orders (restaurant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Dropped only after the replacement exists, so there is no window with no protection at all.
DROP INDEX IF EXISTS public.idx_orders_idempotency_key;
DROP INDEX IF EXISTS public.orders_idempotency_key_unique;

COMMENT ON INDEX public.orders_restaurant_idempotency_key_unique IS
  'Idempotency is per venue. Replaces two identical GLOBAL partial-unique indexes under which two '
  'restaurants generating the same key would reject one another''s orders. Every 23505 recovery '
  'lookup must filter on restaurant_id as well as the key.';

-- --------------------------------------------------------------------------------------------
-- F13. One allocation cannot be settled twice.
-- --------------------------------------------------------------------------------------------
--
-- `settle_order_line_allocations` claims each allocation with a conditional UPDATE
-- (`AND settled_at IS NULL`) and only inserts the ledger row for a claim that returned a row, so
-- the application already makes a double settlement unreachable THROUGH THAT FUNCTION. Nothing
-- made it unreachable through anything else: a second writer, a repaired script, or a future
-- caller that inserts the ledger row without claiming first would be accepted silently.
--
-- The brief's rule -- "do not rely exclusively on application claims" -- is the whole point. This
-- is the database saying the same thing the claim says, so the claim becoming wrong is a failed
-- INSERT rather than money counted twice.
--
-- 16 rows, zero duplicates. The index builds instantly at this size.

CREATE UNIQUE INDEX IF NOT EXISTS order_line_allocation_settlements_one_per_allocation
  ON public.order_line_allocation_settlements (order_line_allocation_id);

COMMENT ON INDEX public.order_line_allocation_settlements_one_per_allocation IS
  'Financial invariant 7: one payment cannot settle the same allocation twice. The conditional '
  'claim in settle_order_line_allocations() already prevents it through that function; this '
  'prevents it through every other writer as well.';

-- --------------------------------------------------------------------------------------------
-- F14. One gateway transaction = one internal payment record.
-- --------------------------------------------------------------------------------------------
--
-- SCOPED TO THE RESTAURANT, DELIBERATELY, AND NOT GLOBALLY.
--
-- The invariant worth enforcing is "this venue did not record the same gateway transaction twice",
-- which is the duplicate that actually occurs: a retry, a racing webhook, a device re-POST. A
-- GLOBAL unique index would additionally assert that no two venues ever see the same transaction
-- id string -- a claim about Finatic's id space that we do not control, and whose failure mode is
-- the worst one available: a real payment at venue B refused insertion because venue A holds the
-- same id, leaving the payment unrecorded. Both forms are satisfied by today's data (zero
-- duplicates either way); only one of them can fail in that direction.
--
-- PARTIAL, because transaction_id is nullable. Production has zero null-or-blank values today, but
-- the column permits them and a refund path could legitimately have none; a partial index leaves
-- those rows alone rather than colliding them all with one another.
--
-- The blank-string exclusion matters: '' is not a transaction id, and without it two rows carrying
-- '' would be a violation.

CREATE UNIQUE INDEX IF NOT EXISTS payment_events_restaurant_transaction_id_unique
  ON public.payment_events (restaurant_id, transaction_id)
  WHERE transaction_id IS NOT NULL AND btrim(transaction_id) <> '';

COMMENT ON INDEX public.payment_events_restaurant_transaction_id_unique IS
  'Financial invariant 6: one gateway transaction = one internal payment record, per venue. '
  'Deliberately NOT global -- a cross-venue id collision would refuse a real payment, which is a '
  'worse failure than the one being prevented.';

-- --------------------------------------------------------------------------------------------
-- The uuid[] order_ids design: EVALUATED, AND DELIBERATELY LEFT ALONE.
-- --------------------------------------------------------------------------------------------
--
-- F14 asks whether `payment_events.order_ids uuid[]` should become a junction table. It should
-- not, in this release, and the reasoning is recorded here rather than left to be re-derived:
--
--   * The array is ALREADY INDEXED for the query that matters -- payment_events_order_ids_gin_idx
--     serves `order_ids @> array[...]`, which is how the resolver's leg 2 and the
--     card-payments-without-sale-row cron both ask their question.
--   * A junction table buys referential integrity on the elements. That is real, and it is not
--     worth a rewrite of every reader on the money path in the same release that changes how
--     settlement works. Two large changes to one table at once is how a regression becomes
--     unattributable.
--   * Nothing about the array blocks any invariant in this sprint. The uniqueness above is on
--     transaction_id, not on the array.
--
-- Revisit when a reader needs to join FROM orders TO events efficiently, which none does today.

COMMENT ON COLUMN public.payment_events.order_ids IS
  'The orders one gateway transaction paid for. Kept as uuid[] with a GIN index rather than '
  'normalised to a junction table: the containment query is already served, and no invariant in '
  'the 2026-09-19 hardening needs the join. Revisit if a reader needs orders -> events.';

-- --------------------------------------------------------------------------------------------
-- THE STATE MACHINE. orders.payment_status may only hold an enumerated value.
-- --------------------------------------------------------------------------------------------
--
-- ENUMERATED FROM THE WRITERS, NOT FROM PRODUCTION. Production holds three values today (paid,
-- cancelled, pending) and constraining to those would make the next legitimate `terminal_pending`
-- write a 500. The nine below are the full set `lib/payments/payment-state-machine.ts` declares,
-- derived from every writer in the codebase; the three present are a subset of them.
--
-- NOT VALID, then VALIDATE as a separate statement. ADD CONSTRAINT ... NOT VALID takes only a
-- SHARE UPDATE EXCLUSIVE lock and returns immediately; VALIDATE CONSTRAINT scans the table without
-- blocking reads or writes. On a 6,598-row table either would be quick, but the pattern is the one
-- to follow when it is not, and doing it here means the rollback story is the same at any size.
--
-- WHY NO CONSTRAINT ON THE TRANSITIONS THEMSELVES. A CHECK constraint sees one row at a time and
-- cannot see the value the row is moving FROM, so "paid may not become pending" is not expressible
-- as one. Expressing it would need a trigger, and a trigger on `orders` on the money path is a
-- larger change than this sprint should make: it would fire on every write in the system, including
-- paths this sprint does not touch. The transition rules are enforced where the writes happen --
-- inside settle_order_payment(), which refuses an illegal transition and rolls back -- and are
-- declared once in payment-state-machine.ts for every other caller. This constraint enforces the
-- ALPHABET; the function and the module enforce the GRAMMAR.

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_payment_status_enumerated;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_payment_status_enumerated
  CHECK (
    payment_status IS NULL OR payment_status IN (
      'unpaid',
      'pending',
      'terminal_pending',
      'cash_pending',
      'failed',
      'amount_mismatch_hold',
      'verification_unavailable_hold',
      'paid',
      'cancelled'
    )
  ) NOT VALID;

-- Separate statement: the scan happens here, without an exclusive lock. Safe to re-run.
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_payment_status_enumerated;

COMMENT ON CONSTRAINT orders_payment_status_enumerated ON public.orders IS
  'The nine values lib/payments/payment-state-machine.ts declares. NULL is permitted because the '
  'column is nullable and 7 legacy rows carry no payment_method either; tightening that is a '
  'separate, data-first change. Enforces the alphabet only -- the legal TRANSITIONS are enforced '
  'in settle_order_payment() and declared in payment-state-machine.ts, because a CHECK cannot see '
  'the value a row is moving from.';
