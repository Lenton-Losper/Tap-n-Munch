-- ADR-005 -- the pass. Adds 'cooked' to the live per-station state vocabulary.
--
-- Shipped AHEAD of the station model deliberately: the station tables (20260827131700-131900)
-- already carry the four states, but the DEPLOYED endpoints still read and write
-- order_lines.kitchen_state / bar_state, which do not. Until these two columns know 'cooked',
-- a kitchen board cannot tell a plated dish from an untouched one, which is the single thing the
-- pass exists to make visible.
--
-- ============================================================================================
-- FOUR STATES, TWO ACTORS
-- ============================================================================================
--
--   outstanding  -> nobody has started it
--   cooked       -> the STATION has made it, and is waiting on the pass
--   ready        -> the PASS has passed it; this is what a waiter walks in to read
--   voided       -> cancelled or amended at the terminal
--
-- A station may write 'cooked'. The pass writes 'ready'. A station cannot mark its own dish ready
-- to run, and that separation is the point.
--
-- ============================================================================================
-- 'done' IS RETIRED AS A STORED VALUE, AND MIGRATED RATHER THAN KEPT ALONGSIDE
-- ============================================================================================
--
-- The old vocabulary had no pass, so 'done' meant "this station has finished with it" -- which
-- under the new vocabulary is READY, not cooked. Mapping it to 'cooked' would invent a pass step
-- nobody performed and hold plates that were already run.
--
-- It is NOT kept in the CHECK beside 'ready'. Two stored values meaning one thing is the #349
-- shape -- two payment_methods columns disagreeing at ten of eleven venues, one of which
-- manufactured a fictional money defect within minutes. So 'done' is translated at the door
-- instead: the bump endpoint accepts it as an input alias and stores 'ready'. One stored meaning,
-- and no client breaks mid-deploy.
--
-- ============================================================================================
-- THE INDEXES ARE REBUILT WITHOUT A STATE PREDICATE, AND THIS IS THE REASON THIS MIGRATION
-- EXISTS AT ALL RATHER THAN BEING A ONE-LINE CHECK WIDENING
-- ============================================================================================
--
-- 20260827131000 indexed the station screens with `WHERE kitchen_state = 'outstanding'`.
--
-- THAT IS A HARDCODED STATE COMPARISON IN DDL. It survives any code audit, because nothing in
-- TypeScript mentions it. The moment a line can sit in a state that is neither 'outstanding' nor
-- finished -- which is exactly what 'cooked' introduces -- the row falls out of the index and the
-- screen query silently stops returning it. No error. No slow query. A plated dish that is simply
-- not on the board, which is the worst possible failure for the feature the pass is meant to fix.
--
-- Shipping the enum without this would have been actively dangerous. The replacements index the
-- state COLUMN instead, so the vocabulary can grow again without rotting them.
--
-- RULE: a WHERE clause on a state value is a hardcoded comparison and must be re-derived whenever
-- that enum changes. Prefer indexing the column.

-- ---------------------------------------------------------------------------
-- ORDER OF OPERATIONS, AND IT IS NOT THE OBVIOUS ONE.
--
-- The first draft of this migration updated 'done' -> 'ready' FIRST and then widened the CHECK,
-- on the reasoning that data should be clean before a constraint tightens. That is backwards: the
-- OLD constraint still forbids 'ready' at the moment of the UPDATE, so the UPDATE is the thing
-- that fails, with a 23514 naming the row it was trying to fix.
--
-- A value must be LEGAL BEFORE IT CAN BE WRITTEN. So the constraint is widened permissively
-- first -- old vocabulary AND new, together -- then the data moves, then the constraint is
-- narrowed to drop the retired value. Three steps, and the middle one is only legal because of
-- the first.
-- ---------------------------------------------------------------------------

-- 1. Widen permissively: everything old, plus everything new. 'done' is temporarily legal here
--    precisely so step 2 can move off it.
ALTER TABLE public.order_lines
  DROP CONSTRAINT IF EXISTS order_lines_kitchen_state_check;
ALTER TABLE public.order_lines
  ADD CONSTRAINT order_lines_kitchen_state_check
  CHECK (kitchen_state IN ('outstanding', 'done', 'cooked', 'ready', 'voided'));

ALTER TABLE public.order_lines
  DROP CONSTRAINT IF EXISTS order_lines_bar_state_check;
ALTER TABLE public.order_lines
  ADD CONSTRAINT order_lines_bar_state_check
  CHECK (bar_state IN ('outstanding', 'done', 'cooked', 'ready', 'voided'));

-- 2. Move the data. 'done' meant "this station has finished with it", which under the new
--    vocabulary is READY -- the old model had no pass, so finished and ready-to-run were one
--    event. Mapping to 'cooked' would invent a pass step nobody performed.
UPDATE public.order_lines SET kitchen_state = 'ready' WHERE kitchen_state = 'done';
UPDATE public.order_lines SET bar_state = 'ready' WHERE bar_state = 'done';

-- 3. Narrow: 'done' is now unreachable as a stored value. Keeping it beside 'ready' would be two
--    stored values meaning one thing, which is the #349 shape. It survives only as an INPUT ALIAS
--    translated at the endpoint, so no client breaks mid-deploy.
ALTER TABLE public.order_lines
  DROP CONSTRAINT order_lines_kitchen_state_check;
ALTER TABLE public.order_lines
  ADD CONSTRAINT order_lines_kitchen_state_check
  CHECK (kitchen_state IN ('outstanding', 'cooked', 'ready', 'voided'));

ALTER TABLE public.order_lines
  DROP CONSTRAINT order_lines_bar_state_check;
ALTER TABLE public.order_lines
  ADD CONSTRAINT order_lines_bar_state_check
  CHECK (bar_state IN ('outstanding', 'cooked', 'ready', 'voided'));

-- ---------------------------------------------------------------------------
-- 3. Rebuild the screen indexes WITHOUT a state predicate. See the header.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.order_lines_kitchen_outstanding_idx;
DROP INDEX IF EXISTS public.order_lines_bar_outstanding_idx;

CREATE INDEX IF NOT EXISTS order_lines_kitchen_state_idx
  ON public.order_lines (restaurant_id, kitchen_state, created_at);

CREATE INDEX IF NOT EXISTS order_lines_bar_state_idx
  ON public.order_lines (restaurant_id, bar_state, created_at);

COMMENT ON COLUMN public.order_lines.kitchen_state IS
  'outstanding | cooked | ready | voided. NULL when the kitchen does not own this line. The STATION writes cooked; the PASS writes ready. ''done'' is retired -- it is accepted as an input alias and stored as ''ready''. NEVER index this with a WHERE predicate on a specific value: adding a state silently drops rows out of such an index with no error.';

COMMENT ON COLUMN public.order_lines.bar_state IS
  'See kitchen_state. Same four states, same two actors.';
