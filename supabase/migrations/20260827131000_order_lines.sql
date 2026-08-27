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
-- THIS TABLE HAS NO MONETARY COLUMN, AND THAT IS STRUCTURAL
-- ============================================================================================
--
-- ADR-005 §2 rules that an item routed 'both' appears on BOTH screens as its own line, each
-- station bumping independently. Two independent states require two rows -- one row cannot hold
-- two -- so a 'both' item fans out into a kitchen row AND a bar row.
--
-- Which means: ONE BILLED ITEM CAN BE TWO ROWS HERE. Summing this table for money double-charges
-- the customer for every 'both' item on the ticket, and production currently holds 1,274 of them.
--
-- So there is no price column, no subtotal, no tax, no total. Not omitted -- REFUSED. The
-- protection is that the numbers are absent, not that a future reader is careful. Money lives in
-- orders.items and orders.total, where it already lives and where it is not fanned out.
--
-- DO NOT ADD A PRICE COLUMN HERE. If a bill needs a line's price, it joins back to
-- orders.items via source_item_index, which is exactly what that column is for.
--
-- ============================================================================================
-- station IS FROZEN AT WRITE TIME, NOT RESOLVED AT READ TIME
-- ============================================================================================
--
-- menu_categories.route_to is read ONCE, when the line is created, and the answer is stored here.
-- Three reasons, any one sufficient:
--
--   1. route_to is editable. A category re-pointed from kitchen to bar while food is on the pass
--      would silently move a line the kitchen has already started cooking.
--   2. Two screens resolving independently can disagree with each other, and nothing would tell
--      anyone that they had.
--   3. A frozen station is the only thing that makes the pre-launch routing report meaningful.
--      A report of what WOULD land where is worthless if the answer can change after it is read.
--
-- 'unrouted' IS NOT A SILENT DEFAULT. A line whose route_to is null lands here as 'unrouted' and
-- the screens show it on BOTH, under a heading that says so. The alternative -- quietly defaulting
-- null to 'kitchen' -- is food that nobody sees on a screen nobody thinks to question. A visible
-- wrong answer gets fixed; an invisible one gets served cold or not at all. Production holds 4 of
-- these today.
--
-- ROUTE DATA IS NOT TRUSTED AND IS NOT CORRECTED HERE. Riviera verifies their own menu against the
-- pre-launch report before go-live. Nothing in this migration cleans, backfills or second-guesses
-- route_to, deliberately.
--
-- ============================================================================================
-- orders.status IS NEITHER READ NOR WRITTEN BY ANYTHING BUILT ON THIS TABLE
-- ============================================================================================
--
-- 'completed' means PAID: ~99.5% of the 2,035 completed orders have completed_at == paid_at to the
-- instant, markOrderPaidConfirmed writes it from any prior status, and the table-close route
-- bulk-stamps it. 6 orders are in 'ready' and 1 in 'preparing' in the entire production history.
--
-- A line's state is a property of THE LINE. The two vocabularies coexist and mean different
-- things: orders.status means paid, order_lines.state means made. That is a deliberate
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

  -- Position in orders.items this line was produced from. THE JOIN BACK TO MONEY: a 'both' item
  -- produces two rows carrying the SAME index, which is what makes the double-count detectable
  -- rather than silent.
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

  -- Frozen at write time. See the header. 'unrouted' is a real, visible value, not an error state.
  station text NOT NULL CHECK (station IN ('kitchen', 'bar', 'unrouted')),

  -- Denormalised current value; order_line_events is the truth. See 20260827131100.
  state text NOT NULL DEFAULT 'outstanding'
    CHECK (state IN ('outstanding', 'done', 'voided')),

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.order_lines IS
  'ADR-005: the FULFILMENT record -- what a station has to make. NOT a billing record. An item routed ''both'' fans out into two rows, so one billed item can be two rows here; this table therefore carries no monetary column and must never be summed for money. Billing stays in orders.items.';

COMMENT ON COLUMN public.order_lines.source_item_index IS
  'Position in orders.items this line came from. The join back to price. A ''both'' item produces two rows sharing one index -- that is the fan-out, and it is why no money lives on this table.';

COMMENT ON COLUMN public.order_lines.station IS
  'Resolved from menu_categories.route_to ONCE at write time and frozen. Never re-derived at read time: route_to is editable, and a line already on the pass must not move. ''unrouted'' means route_to was null -- it displays on both screens under a visible heading rather than defaulting silently to kitchen.';

COMMENT ON COLUMN public.order_lines.state IS
  'Whether this line is outstanding, done or voided. Denormalised current value of order_line_events, which is the authoritative history. Unrelated to orders.status, which means PAID.';

COMMENT ON COLUMN public.order_lines.line_note IS
  'Per-line note such as "medium". Not the same thing as orders.order_instructions, which cannot say which of three steaks is the rare one.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- THE STATION SCREEN QUERY, and the only one that runs continuously: every outstanding line for
-- this venue at this station. Partial, because a screen never asks for done or voided lines and
-- the done rows will outnumber the outstanding ones by orders of magnitude within a week.
CREATE INDEX IF NOT EXISTS order_lines_station_outstanding_idx
  ON public.order_lines (restaurant_id, station, created_at)
  WHERE state = 'outstanding';

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
