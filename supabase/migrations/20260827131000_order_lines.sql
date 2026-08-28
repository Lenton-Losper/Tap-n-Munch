-- ADR-005 §1 and §2 -- the fulfilment record. One row per line a station has to make.
--
-- NOT APPLIED BY THE AUTHORING AGENT. Written, committed, left for the deploy path to apply.
--
-- ============================================================================================
-- WHY A NEW TABLE AND NOT orders.items
-- ============================================================================================
--
-- orders.items is JSONB. Each item object carries 17 keys and not one of them is a status, a
-- ready flag, or a timestamp. There is no order_items table. A station cannot mark a line done
-- against a structure with nowhere to write "done", and JSONB cannot be indexed usefully for
-- "every outstanding kitchen line at this venue" -- the one query both screens run constantly.
--
-- orders.items IS NOT TOUCHED BY THIS MIGRATION OR BY ANYTHING BUILT ON IT. It remains the
-- historical record and, more importantly, the BILLING record. The 2,260 existing orders keep it
-- as their only record.
--
-- THERE IS NO BACKFILL, AND THAT IS THE RULING. New orders write lines; old orders never gain
-- them. A consequence worth stating plainly rather than discovering later: the kitchen and bar
-- screens are blind to every pre-existing order. That is correct. Those orders are history, and
-- 2,035 of them are 'completed', which at this venue means PAID, not made.
--
-- ============================================================================================
-- ONE LINE, PER-STATION STATE
-- ============================================================================================
--
-- RULED. An item routed 'both' is ONE row carrying TWO states, not two rows.
--
-- The requirement has two halves that pull in opposite directions:
--
--   * The kitchen marking its half done must NOT clear the bar's half. So the state cannot be
--     a single column.
--   * A cancellation must cancel ONE thing, and the bill must count the item ONCE. So the line
--     cannot be two rows.
--
-- `kitchen_state` and `bar_state` satisfy both. Each is NULL for a station that does not own the
-- line -- a kitchen-only line has `bar_state IS NULL` -- and non-null states bump independently.
--
-- An earlier draft fanned 'both' into two rows. It got independent bumping right and everything
-- else wrong: two rows meant a cancel had to find and void both, and any sum over the table
-- counted the item twice. The constraint below makes the states-match-route invariant
-- unfalsifiable rather than a convention the writing code is trusted to keep.
--
-- READY TO RUN means EVERY STATION THAT OWNS THE LINE HAS MARKED IT. As a predicate:
--
--     coalesce(kitchen_state, 'done') = 'done' AND coalesce(bar_state, 'done') = 'done'
--
-- A NULL state is a station that does not own the line, so it cannot hold the line back. That
-- predicate has ONE definition in code, `isLineReady` in lib/orders/order-lines.ts, so the
-- runner's view and the station screens cannot come to different answers about the same plate.
--
-- ============================================================================================
-- THIS TABLE HAS NO MONETARY COLUMN
-- ============================================================================================
--
-- Not because of the fan-out -- that reason died with the two-row draft above, and a comment
-- asserting it would now be false.
--
-- The reason is ONE SOURCE OF TRUTH. Money lives in orders.items and orders.total, where it
-- already lives, where the receipt reads it, and where the settle path charges it. A price on
-- the fulfilment record is a second place for the same number to live, and the second place is
-- the one that goes stale after a comp, a discount or a re-price.
--
-- If a bill needs a line's price it joins back through source_item_index, which is what that
-- column is for. DO NOT ADD A PRICE COLUMN HERE.
--
-- ============================================================================================
-- route_to IS COPIED ONTO THE LINE AT CREATION -- A GENERAL PRINCIPLE, NOT A CONVENIENCE
-- ============================================================================================
--
-- RULED: a line records what was true when it was created. `route_to` is read from
-- menu_categories ONCE, at write time, and frozen here. It is never re-derived at read time.
--
-- A menu edit at 8pm must not move food that is already cooking. This is the same rule the
-- immutable receipt snapshot follows, and for the same reason: a record of what happened cannot
-- be allowed to change because a catalog row changed afterwards.
--
-- 'unrouted' IS IN THE ENUM AND IS NOT A SILENT DEFAULT. A line whose category route_to is null,
-- missing or unrecognised is stored as 'unrouted' and shown on BOTH screens under a heading that
-- says so. Quietly defaulting null to 'kitchen' is food nobody sees on a screen nobody thinks to
-- question. Production holds 4 of these today.
--
-- ROUTE DATA IS NOT TRUSTED AND IS NOT CORRECTED HERE. Riviera verifies their own menu against
-- the pre-launch report before go-live. Nothing in this migration cleans, backfills or
-- second-guesses route_to, deliberately.
--
-- ============================================================================================
-- orders.status IS NEITHER READ NOR WRITTEN BY ANYTHING BUILT ON THIS TABLE
-- ============================================================================================
--
-- 'completed' means PAID: ~99.5% of the 2,035 completed orders have completed_at == paid_at to
-- the instant, markOrderPaidConfirmed writes it from any prior status, and the table-close route
-- bulk-stamps it. 6 orders are in 'ready' and 1 in 'preparing' in the entire production history.
--
-- A line's state is a property of THE LINE. The two vocabularies coexist and mean different
-- things: orders.status means paid, order_lines states mean made. That is a deliberate
-- inconsistency, named here so nobody later "tidies" it by wiring one to the other.

CREATE TABLE IF NOT EXISTS public.order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant scope. NOT NULL and FK'd, because unlike a crash report there is no scenario where a
  -- fulfilment line belongs to no venue -- it was written by a terminal holding that venue's token.
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,

  -- Denormalised from the order so the station screens and the per-waiter reports do not join
  -- through orders for the commonest question. NULL for a non-tab order.
  tab_id uuid REFERENCES public.tabs(id) ON DELETE SET NULL,

  -- Position in orders.items this line was produced from. THE JOIN BACK TO MONEY, and now
  -- one-to-one: one item, one line, one index.
  source_item_index integer NOT NULL,

  -- NULLABLE and ON DELETE SET NULL: a menu item deleted next month must not delete or block the
  -- historical record of the night it was ordered.
  menu_item_id uuid REFERENCES public.menu_items(id) ON DELETE SET NULL,

  -- What the kitchen reads. Snapshotted because a menu rename must not rewrite history, and
  -- because the screen has to work when menu_item_id is null.
  name_snapshot text NOT NULL,

  quantity numeric NOT NULL,

  -- Per-line note -- "medium", "well done". Distinct from orders.order_instructions, which is
  -- order-level free text and is NOT a substitute: an instruction on the order cannot tell the
  -- kitchen which of three steaks is the rare one.
  line_note text,

  -- Frozen at creation from menu_categories.route_to. See the header: a line records what was
  -- true when it was created.
  route_to text NOT NULL CHECK (route_to IN ('kitchen', 'bar', 'both', 'unrouted')),

  -- Per-station state. NULL means this station does not own this line and cannot hold it back.
  -- order_line_events is the authoritative history of every transition; these are the current
  -- values, kept for the partial indexes the screens live on.
  kitchen_state text CHECK (kitchen_state IN ('outstanding', 'done', 'voided')),
  bar_state text CHECK (bar_state IN ('outstanding', 'done', 'voided')),

  created_at timestamptz NOT NULL DEFAULT now(),

  -- THE INVARIANT, ENFORCED RATHER THAN TRUSTED.
  --
  -- "Populated only for the stations that line routes to" is the whole design; leaving it to the
  -- writing code means the first caller that forgets produces a kitchen line the kitchen cannot
  -- see, and nothing reports it. 'unrouted' owns BOTH stations deliberately -- it shows on both
  -- screens, so both must be able to clear it.
  CONSTRAINT order_lines_states_match_route CHECK (
    (route_to = 'kitchen' AND kitchen_state IS NOT NULL AND bar_state IS NULL)
    OR (route_to = 'bar' AND bar_state IS NOT NULL AND kitchen_state IS NULL)
    OR (route_to IN ('both', 'unrouted') AND kitchen_state IS NOT NULL AND bar_state IS NOT NULL)
  )
);

COMMENT ON TABLE public.order_lines IS
  'ADR-005: the FULFILMENT record -- what a station has to make. NOT a billing record. One row per ordered item, carrying frozen route_to plus per-station kitchen_state/bar_state so the kitchen bumping cannot clear the bar while a cancellation still cancels one thing and the bill counts it once. Carries no monetary column: money has one home, orders.items.';

COMMENT ON COLUMN public.order_lines.route_to IS
  'Copied from menu_categories.route_to at creation and frozen. Never re-derived at read time -- a menu edit at 8pm must not move food already cooking, the same rule the immutable receipt snapshot follows. ''unrouted'' means route_to was null, missing or unrecognised; it displays on both screens under a visible heading rather than defaulting silently to kitchen.';

COMMENT ON COLUMN public.order_lines.kitchen_state IS
  'NULL when the kitchen does not own this line, and a NULL state cannot hold the line back. Ready-to-run is coalesce(kitchen_state,''done'')=''done'' AND coalesce(bar_state,''done'')=''done'' -- defined once in isLineReady(), lib/orders/order-lines.ts.';

COMMENT ON COLUMN public.order_lines.bar_state IS
  'NULL when the bar does not own this line. See kitchen_state.';

COMMENT ON COLUMN public.order_lines.source_item_index IS
  'Position in orders.items this line came from. The join back to price, one-to-one. No price is stored here: money has one home, and a second copy is the one that goes stale after a comp or a re-price.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- THE TWO STATION SCREEN QUERIES, and the only ones that run continuously. Partial, because a
-- screen never asks for done or voided lines and those will outnumber the outstanding ones by
-- orders of magnitude within a week. Separate indexes per station because the screens are
-- separate and each asks only about its own column.
CREATE INDEX IF NOT EXISTS order_lines_kitchen_outstanding_idx
  ON public.order_lines (restaurant_id, created_at)
  WHERE kitchen_state = 'outstanding';

CREATE INDEX IF NOT EXISTS order_lines_bar_outstanding_idx
  ON public.order_lines (restaurant_id, created_at)
  WHERE bar_state = 'outstanding';

-- "Show me this order's lines" -- the terminal, the amend path, and the card that groups lines
-- on the station screen.
CREATE INDEX IF NOT EXISTS order_lines_order_idx
  ON public.order_lines (order_id);

-- Per-tab reads: what has this table had, and what is still outstanding at settle.
CREATE INDEX IF NOT EXISTS order_lines_tab_idx
  ON public.order_lines (tab_id)
  WHERE tab_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS: staff with orders:read may read. Every write is service role.
-- ---------------------------------------------------------------------------
--
-- Writes go through the API route holding the service key, matching held_payments. This is
-- deliberately INDEPENDENT of ADR-005 §8.1 (the unresolved question of what credential a
-- wall-mounted screen carries for a week when terminal auth expires in an hour). §8.1 decides how
-- the ROUTE authenticates its caller; it does not change this policy, so the schema is not blocked
-- on it.
ALTER TABLE public.order_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized staff can read order lines" ON public.order_lines;
CREATE POLICY "Authorized staff can read order lines"
  ON public.order_lines
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'orders:read'));
