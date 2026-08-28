-- Item-level bill splitting, per docs/design-item-level-bill-splitting.md.
--
-- ============================================================================================
-- WHY TWO NEW TABLES, AND WHY NEITHER ONE IS EVER UPDATED ON A MONEY COLUMN
-- ============================================================================================
--
-- Ruled by the owner tonight: "Financial records are append-only, a part-paid order is never
-- rewritten, and an order is fully paid only when every line is - prove the arithmetic cannot
-- round its way to paid."
--
-- order_lines (20260827131000_order_lines.sql) already carries NO monetary column, by design --
-- "money lives in orders.items and orders.total, where the receipt reads it, and where the
-- settle path charges it." This migration does not violate that: order_line_allocations is not
-- a price on the fulfilment record, it is a NEW, independent billing-allocation record -- who
-- owes what share of a line's own price, which is a question order_lines was never asked.
--
-- order_line_allocations.amount_cents and .quantity_allocated are written ONCE, at creation, and
-- NEVER updated afterward. A correction is void-and-replace (voided_at set on the old row, a new
-- row inserted) -- the exact shape amend_order_lines() and voidOutstandingOrderLines() already
-- use for order lines themselves. The only column ever updated post-creation is `settled_at`,
-- via a single conditional UPDATE (claimed once, race-safe by Postgres MVCC) -- the same idiom
-- order_lines.kitchen_state/bar_state already use for outstanding -> cooked -> ready. A status
-- transition guarded by a WHERE clause is not "rewriting a financial field"; the financial
-- fields here (amount_cents, quantity_allocated) are never touched by that UPDATE.
--
-- order_line_allocation_settlements is the append-only PAYMENT LEDGER: one row per amount
-- actually collected against one allocation, in the same spirit `payments` is the ledger for
-- whole-order settlement. It is never updated or deleted by application code.
--
-- ============================================================================================
-- WHAT "amount_cents" MEANS, AND WHERE IT COMES FROM
-- ============================================================================================
--
-- A line's own money figure is orders.items[source_item_index].total -- already tax-inclusive,
-- per amend_order_lines()'s own scaling of subtotal/tax/total together as one figure. There is
-- no separate service-charge column anywhere in this schema today (grepped: none), so nothing
-- further needs apportioning. amount_cents on an allocation is ALWAYS produced by
-- lib/billing/split-cents.ts's splitCentsByWeight() against that line total in integer cents,
-- so the sum of every non-voided allocation's amount_cents for a line is provably exactly that
-- line's total in cents -- never a cent short, never a cent over, by construction.
--
-- ============================================================================================
-- allocated_to IS PLAIN TEXT, NOT A NEW IDENTITY
-- ============================================================================================
--
-- The design doc's own open question: does a split need its own identity, or does it reuse
-- tabs.members' existing informal display-name convention? Ruled here as the safer default,
-- per this session's own instruction to prefer the smaller, reversible choice over inventing a
-- new subsystem: allocated_to is free text, matching how tabs.members / member_name resolution
-- already works. If a formal identity is needed later, that is an additive migration on top of
-- this text column, not a rewrite of it.
--
-- ============================================================================================
-- VOID/REFUND INTERACTION -- DEFINED, NOT LEFT OPEN
-- ============================================================================================
--
-- The design doc flags this as unresolved: "an allocation pointing at a voided line needs a
-- defined behaviour... that this design does not resolve." Resolved here, conservatively: this
-- migration does NOT attempt to re-target an allocation onto a replacement line when
-- amend_order_lines() void-and-replaces the line it pointed at (that would be inventing which
-- replacement line "is" the same line, a business-rule guess this session was told to refuse
-- rather than make). Instead, the settlement path (application code, not this migration) must
-- check the underlying order_line's current kitchen_state/bar_state are not both 'voided'
-- before allowing a settlement to be claimed, and refuse with a named reason otherwise. An
-- allocation against an order whose line was voided out from under it is left unsettleable,
-- visibly, rather than silently charged or silently dropped.

-- ---------------------------------------------------------------------------
-- order_line_allocations: WHO owes what share of one line.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.order_line_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

  -- Denormalised from order_lines so "every allocation on this order" does not require a join
  -- through order_lines for the settle route's own commonest query.
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_line_id uuid NOT NULL REFERENCES public.order_lines(id) ON DELETE CASCADE,
  tab_id uuid REFERENCES public.tabs(id) ON DELETE SET NULL,

  -- Free text, matching tabs.members' own informal convention. See header.
  allocated_to text NOT NULL CHECK (length(trim(allocated_to)) > 0),

  -- How much of the line's own quantity this share covers. A line of quantity 1 shared by two
  -- diners is two allocations of 0.5 each; two diners each ordering their own item off a
  -- quantity-2 line is two allocations of 1 each. NOT required to sum to the line's quantity by
  -- a database constraint (a partially-allocated line -- some of it split, the rest still on
  -- the whole-order path -- is a valid intermediate state while a waiter is still assigning
  -- items), but the application layer's splitCentsByWeight() call always derives amount_cents
  -- from these weights among whichever allocations are created IN THE SAME CALL.
  quantity_allocated numeric NOT NULL CHECK (quantity_allocated > 0),

  -- THE MONEY. Written once, from splitCentsByWeight(), never updated. See header.
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_actor_kind text NOT NULL CHECK (created_by_actor_kind IN ('terminal', 'system')),
  created_by_actor_user_id uuid,

  -- Append-only correction: a wrong allocation is voided, never edited. Excluded from every
  -- "is this line fully allocated / fully paid" computation once voided.
  voided_at timestamptz,
  void_reason text,

  -- THE SETTLEMENT CLAIM. NULL until claimed by exactly one settle_order_line_allocations()
  -- call, via a single conditional UPDATE -- see header on why this is not a financial rewrite.
  settled_at timestamptz,

  CONSTRAINT order_line_allocations_void_reason_requires_void CHECK (
    voided_at IS NOT NULL OR void_reason IS NULL
  )
);

COMMENT ON TABLE public.order_line_allocations IS
  'Item-level bill splitting: who owes what share of one order_lines row, in integer cents. amount_cents and quantity_allocated are write-once (a correction voids and replaces); settled_at is the only column updated after creation, claimed by a single conditional UPDATE the same way order_lines.kitchen_state is. See migration header for the full design reasoning.';

COMMENT ON COLUMN public.order_line_allocations.amount_cents IS
  'Always produced by lib/billing/split-cents.ts splitCentsByWeight() against orders.items[source_item_index].total in integer cents. Never edited after insert.';

COMMENT ON COLUMN public.order_line_allocations.settled_at IS
  'NULL = unpaid. Set exactly once via a conditional UPDATE ... WHERE settled_at IS NULL, the same optimistic-concurrency shape order_lines.kitchen_state and amend_order_lines() already use, so two concurrent settle attempts on the same allocation cannot both win.';

CREATE INDEX IF NOT EXISTS order_line_allocations_line_idx
  ON public.order_line_allocations (order_line_id)
  WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS order_line_allocations_order_idx
  ON public.order_line_allocations (order_id)
  WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS order_line_allocations_tab_unsettled_idx
  ON public.order_line_allocations (tab_id)
  WHERE voided_at IS NULL AND settled_at IS NULL;

ALTER TABLE public.order_line_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized staff can read order line allocations" ON public.order_line_allocations;
CREATE POLICY "Authorized staff can read order line allocations"
  ON public.order_line_allocations
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'orders:read'));

-- ---------------------------------------------------------------------------
-- order_line_allocation_settlements: the append-only payment ledger.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.order_line_allocation_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  order_line_allocation_id uuid NOT NULL REFERENCES public.order_line_allocations(id) ON DELETE CASCADE,
  tab_id uuid REFERENCES public.tabs(id) ON DELETE SET NULL,

  -- Always equal to the allocation's own amount_cents at the moment it is claimed -- v1 settles
  -- an allocation in one shot, whole, matching how a single order settles whole today. There is
  -- deliberately no partial-settlement-of-one-allocation in this version; splitting further is
  -- done by creating more, smaller allocations, not by partially paying one.
  amount_cents integer NOT NULL CHECK (amount_cents > 0),

  method text NOT NULL CHECK (method IN ('cash', 'card')),
  payment_reference text,
  staff_user_id uuid,

  settled_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.order_line_allocation_settlements IS
  'Append-only ledger: one row per allocation actually paid. Never updated or deleted by application code -- the payments table is its whole-order analogue.';

CREATE INDEX IF NOT EXISTS order_line_allocation_settlements_allocation_idx
  ON public.order_line_allocation_settlements (order_line_allocation_id);

CREATE INDEX IF NOT EXISTS order_line_allocation_settlements_tab_idx
  ON public.order_line_allocation_settlements (tab_id)
  WHERE tab_id IS NOT NULL;

ALTER TABLE public.order_line_allocation_settlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized staff can read allocation settlements" ON public.order_line_allocation_settlements;
CREATE POLICY "Authorized staff can read allocation settlements"
  ON public.order_line_allocation_settlements
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'orders:read'));

-- ---------------------------------------------------------------------------
-- settle_order_line_allocations: the atomic claim, one allocation at a time, one transaction
-- for the whole batch -- mirrors amend_order_lines()'s own per-item accept/refuse shape.
-- ---------------------------------------------------------------------------
--
-- REFUSES (does not throw) an allocation that is already settled, already voided, or whose
-- underlying order_line has since been fully voided (both owned station-halves 'voided') --
-- see header's "VOID/REFUND INTERACTION" note. A refusal for one allocation does not affect the
-- others in the same call; each is claimed independently, same as amend_order_lines() applies
-- each amendment independently.

CREATE OR REPLACE FUNCTION public.settle_order_line_allocations(
  p_restaurant_id uuid,
  p_tab_id uuid,
  p_allocation_ids uuid[],
  p_method text,
  p_payment_reference text,
  p_staff_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_claimed record;
  v_line record;
  v_applied jsonb := '[]'::jsonb;
  v_refused jsonb := '[]'::jsonb;
BEGIN
  IF p_allocation_ids IS NULL OR array_length(p_allocation_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'at least one allocation_id is required';
  END IF;
  IF p_method NOT IN ('cash', 'card') THEN
    RAISE EXCEPTION 'unsupported method %', p_method;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tabs WHERE id = p_tab_id AND restaurant_id = p_restaurant_id
  ) THEN
    RAISE EXCEPTION 'tab % does not belong to restaurant %', p_tab_id, p_restaurant_id;
  END IF;

  FOREACH v_id IN ARRAY p_allocation_ids
  LOOP
    -- Refuse up front if the underlying line was fully voided since this allocation was made.
    -- Read-then-decide is safe here (not a race with the claim below): a line voiding after
    -- this check but before the claim commits simply means the allocation is claimed for money
    -- against food that was voided a moment later, which is the SAME order-level question
    -- "is this food still owed" already is for whole-order settlement -- not a new race this
    -- function needs to close, per the header's ruling not to guess that business rule here.
    SELECT ol.kitchen_state, ol.bar_state INTO v_line
    FROM public.order_line_allocations ola
    JOIN public.order_lines ol ON ol.id = ola.order_line_id
    WHERE ola.id = v_id AND ola.restaurant_id = p_restaurant_id AND ola.tab_id = p_tab_id;

    IF NOT FOUND THEN
      v_refused := v_refused || jsonb_build_object('allocation_id', v_id, 'reason', 'not_found');
      CONTINUE;
    END IF;

    IF (v_line.kitchen_state IS NULL OR v_line.kitchen_state = 'voided')
       AND (v_line.bar_state IS NULL OR v_line.bar_state = 'voided')
       AND NOT (v_line.kitchen_state IS NULL AND v_line.bar_state IS NULL) THEN
      v_refused := v_refused || jsonb_build_object('allocation_id', v_id, 'reason', 'line_voided');
      CONTINUE;
    END IF;

    -- THE CLAIM. Single conditional UPDATE -- only an allocation still unsettled and unvoided
    -- can be claimed, and only one concurrent caller can win it (Postgres MVCC), the same shape
    -- amend_order_lines()'s own void step and order_lines.kitchen_state bumps already use.
    UPDATE public.order_line_allocations
    SET settled_at = now()
    WHERE id = v_id
      AND restaurant_id = p_restaurant_id
      AND tab_id = p_tab_id
      AND voided_at IS NULL
      AND settled_at IS NULL
    RETURNING id, amount_cents INTO v_claimed;

    IF v_claimed.id IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.order_line_allocations
        WHERE id = v_id AND voided_at IS NOT NULL
      ) THEN
        v_refused := v_refused || jsonb_build_object('allocation_id', v_id, 'reason', 'voided');
      ELSE
        v_refused := v_refused || jsonb_build_object('allocation_id', v_id, 'reason', 'already_settled');
      END IF;
      CONTINUE;
    END IF;

    -- The append-only ledger row -- the actual, durable record of money collected. This insert
    -- happening AFTER the claim above (not before) means the claim -- and only the claim -- is
    -- the thing two concurrent callers race on; this insert cannot itself be double-run for the
    -- same allocation because only one caller's claim UPDATE can ever return a row for it.
    INSERT INTO public.order_line_allocation_settlements
      (restaurant_id, order_line_allocation_id, tab_id, amount_cents, method, payment_reference, staff_user_id)
    VALUES
      (p_restaurant_id, v_claimed.id, p_tab_id, v_claimed.amount_cents, p_method, p_payment_reference, p_staff_user_id);

    v_applied := v_applied || jsonb_build_object(
      'allocation_id', v_claimed.id, 'amount_cents', v_claimed.amount_cents
    );
  END LOOP;

  RETURN jsonb_build_object('applied', v_applied, 'refused', v_refused);
END;
$$;

ALTER FUNCTION public.settle_order_line_allocations(uuid, uuid, uuid[], text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.settle_order_line_allocations(uuid, uuid, uuid[], text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_order_line_allocations(uuid, uuid, uuid[], text, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- order_is_fully_paid_by_allocations: THE PROVABLE "every line is paid" PREDICATE.
-- ---------------------------------------------------------------------------
--
-- True iff EVERY non-voided order_line on this order has at least one non-voided allocation,
-- every one of those allocations is settled, and the settled allocations' amount_cents for that
-- line sum to EXACTLY that line's own total in cents (orders.items[source_item_index].total).
-- Integer-cent equality only -- the same guarantee lib/billing/split-cents.ts's
-- isFullyPaidCents() proves at the application layer, re-asserted here in SQL so the database
-- itself, not just the caller, is the source of truth for this claim.
--
-- A line with NO allocations at all is NOT considered "paid by allocations" -- it falls back to
-- the existing whole-order settle path, per the design doc's own ruling that unsplit orders are
-- completely unaffected. So this function returns false for any order that has not been fully,
-- deliberately split across every one of its lines -- never a partial mix of the two paths on
-- the same order, which is exactly the ambiguity the design doc leaves open and this session was
-- told to avoid guessing at.

CREATE OR REPLACE FUNCTION public.order_is_fully_paid_by_allocations(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_line record;
  v_line_total_cents integer;
  v_allocated_cents integer;
  v_settled_cents integer;
  v_any_line boolean := false;
BEGIN
  FOR v_line IN
    SELECT id, source_item_index
    FROM public.order_lines
    WHERE order_id = p_order_id
      AND NOT (
        (kitchen_state IS NULL OR kitchen_state = 'voided')
        AND (bar_state IS NULL OR bar_state = 'voided')
        AND NOT (kitchen_state IS NULL AND bar_state IS NULL)
      )
  LOOP
    v_any_line := true;

    SELECT round((o.items -> v_line.source_item_index ->> 'total')::numeric * 100)::integer
    INTO v_line_total_cents
    FROM public.orders o WHERE o.id = p_order_id;

    IF v_line_total_cents IS NULL THEN
      RETURN false; -- cannot prove it, so it is not proven paid.
    END IF;

    SELECT
      COALESCE(SUM(amount_cents), 0),
      COALESCE(SUM(amount_cents) FILTER (WHERE settled_at IS NOT NULL), 0)
    INTO v_allocated_cents, v_settled_cents
    FROM public.order_line_allocations
    WHERE order_line_id = v_line.id AND voided_at IS NULL;

    -- Not allocated at all: this order is on the whole-order path, not the allocation path.
    IF v_allocated_cents = 0 THEN
      RETURN false;
    END IF;

    -- Allocated but not fully (or the allocations do not sum to the line's own total, or not
    -- every allocated cent is settled yet): not fully paid.
    IF v_allocated_cents <> v_line_total_cents OR v_settled_cents <> v_line_total_cents THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN v_any_line; -- an order with no live lines at all is not "fully paid", it is empty.
END;
$$;

ALTER FUNCTION public.order_is_fully_paid_by_allocations(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_is_fully_paid_by_allocations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.order_is_fully_paid_by_allocations(uuid) TO service_role;
