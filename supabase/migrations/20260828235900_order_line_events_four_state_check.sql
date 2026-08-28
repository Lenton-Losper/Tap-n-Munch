-- ADR-005 -- widen order_line_events.from_state / to_state to the real four-state vocabulary.
--
-- NOT APPLIED TO STAGING OR PRODUCTION BY THE AUTHORING AGENT. Written, committed, left for the
-- deploy path to apply -- same convention as 20260827131000_order_lines.sql and
-- 20260827131100_order_line_events.sql themselves.
--
-- ============================================================================================
-- DISCOVERED, NOT GUESSED: a live proof against STAGING (mdqjpxwczrhkxkbqatqa) on 2026-08-28,
-- while verifying the fix to app/api/terminal/station-lines/[lineId]/route.ts and
-- app/api/station/order-lines/[lineId]/state/route.ts.
-- ============================================================================================
--
-- 20260828141000_cooked_state.sql widened order_lines.kitchen_state_check and
-- order_lines.bar_state_check to ('outstanding', 'cooked', 'ready', 'voided'). It did NOT touch
-- this table. order_line_events.from_state / to_state are STILL the old three-state CHECK
-- ('outstanding', 'done', 'voided') that predates the pass entirely.
--
-- The result, proven live rather than inferred: a real call to the REAL, already-merged
-- POST /api/station/order-lines/[lineId]/state -- via a real 'ready_to_run' tap through
-- POST /api/terminal/station-lines/[lineId], with a real signed terminal JWT, against a real
-- seeded staging row -- moved order_lines.kitchen_state to 'ready' correctly (the route-level fix
-- this migration ships alongside is correct), but the SAME request's own order_line_events insert
-- was rejected outright:
--
--   error: new row for relation "order_line_events" violates check constraint
--   "order_line_events_from_state_check"
--   row: (..., station=kitchen, from_state=cooked, to_state=ready, actor_kind=station, ...)
--
-- That insert failure is caught and logged by the route (by design -- a missing audit row must
-- not fail a request whose state change already landed correctly), which is exactly the
-- "swallowed failure" shape this entire fix exists to close. Every 'cooked' or 'ready' transition
-- through the real, already-merged domain route currently writes ZERO audit rows on live staging,
-- silently, right now -- not because of anything guessed in the two terminal-facing routes this
-- session fixed, but because this table's own CHECK constraint was never updated when the pass
-- (20260828141000) shipped.
--
-- ============================================================================================
-- SAME THREE-STEP SHAPE AS 20260828141000_cooked_state.sql, FOR THE SAME REASON
-- ============================================================================================
--
-- Widen permissively first (old vocabulary AND new, together) so any existing 'done' row remains
-- legal while it is moved; move the data; then narrow to the final four-state vocabulary. A value
-- must be legal before it can be written, so narrowing first would make the UPDATE in step 2 the
-- thing that fails.
--
-- 'done' meant "this station finished with it" under the pre-pass vocabulary, which under the
-- four-state vocabulary is READY (see 20260828141000's own note: the old model had no pass, so
-- finished and ready-to-run were one event). Any existing order_line_events row recording 'done'
-- is migrated to 'ready' for the same reason order_lines' stored values were.

-- 1. Widen permissively.
ALTER TABLE public.order_line_events
  DROP CONSTRAINT IF EXISTS order_line_events_from_state_check;
ALTER TABLE public.order_line_events
  ADD CONSTRAINT order_line_events_from_state_check
  CHECK (from_state IN ('outstanding', 'done', 'cooked', 'ready', 'voided'));

ALTER TABLE public.order_line_events
  DROP CONSTRAINT IF EXISTS order_line_events_to_state_check;
ALTER TABLE public.order_line_events
  ADD CONSTRAINT order_line_events_to_state_check
  CHECK (to_state IN ('outstanding', 'done', 'cooked', 'ready', 'voided'));

-- 2. Move any existing 'done' data.
UPDATE public.order_line_events SET from_state = 'ready' WHERE from_state = 'done';
UPDATE public.order_line_events SET to_state = 'ready' WHERE to_state = 'done';

-- 3. Narrow: 'done' is now unreachable as a stored value on this table, matching order_lines.
ALTER TABLE public.order_line_events
  DROP CONSTRAINT order_line_events_from_state_check;
ALTER TABLE public.order_line_events
  ADD CONSTRAINT order_line_events_from_state_check
  CHECK (from_state IN ('outstanding', 'cooked', 'ready', 'voided'));

ALTER TABLE public.order_line_events
  DROP CONSTRAINT order_line_events_to_state_check;
ALTER TABLE public.order_line_events
  ADD CONSTRAINT order_line_events_to_state_check
  CHECK (to_state IN ('outstanding', 'cooked', 'ready', 'voided'));

COMMENT ON COLUMN public.order_line_events.from_state IS
  'NULL on the creation event. outstanding | cooked | ready | voided otherwise -- same four-state vocabulary as order_lines.kitchen_state/bar_state (20260828141000_cooked_state.sql). Widened from the original outstanding|done|voided CHECK, which silently rejected every cooked/ready audit write until this migration (found via a live staging proof, 2026-08-28).';

COMMENT ON COLUMN public.order_line_events.to_state IS
  'outstanding | cooked | ready | voided. See from_state.';
