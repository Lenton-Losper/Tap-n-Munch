-- @env: both
--
-- 'collected' on order_lines.kitchen_state / bar_state -- the half 20260829160000 did not do.
--
-- ============================================================================================
-- 20260829160000'S HEADER ASSERTS A PREMISE THAT WAS ALREADY FALSE WHEN IT WAS WRITTEN
-- ============================================================================================
--
-- Read 20260829160000_collected_state.sql before this one and you will find, under "WHY THE
-- CHECK CONSTRAINTS ARE WIDENED HERE AND order_lines ITSELF IS NOT":
--
--     order_lines.kitchen_state/bar_state carry no CHECK constraint today (confirmed against
--     production 2026-08-28) -- free text, validated only by what application code writes.
--
-- THAT IS NOT TRUE, AND WAS NOT TRUE ON THE DAY IT WAS WRITTEN. 20260828141000_cooked_state.sql
-- created order_lines_kitchen_state_check and order_lines_bar_state_check the previous day, and
-- 20260828235900 is stamped 23:59 on that same 2026-08-28 -- so the constraints predate the
-- "confirmed against production 2026-08-28" note by hours, not days. Both migrations are in the
-- ledger on BOTH databases. Measured 2026-08-31, straight out of pg_constraint on production:
--
--     order_lines_kitchen_state_check  CHECK (kitchen_state = ANY (ARRAY[
--         'outstanding','cooked','ready','voided']))
--     order_lines_bar_state_check      CHECK (bar_state     = ANY (ARRAY[
--         'outstanding','cooked','ready','voided']))
--
-- Staging is identical. Leaving that paragraph unanswered is how the next person re-derives this
-- from scratch: it is a specific, dated, confident claim about production, and it is wrong.
-- 20260829160000 is NOT edited to say so -- a committed migration is a record of what ran, not a
-- document to correct after the fact -- so the correction lives here, where anyone tracing the
-- constraint's history arrives next.
--
-- ============================================================================================
-- WHAT THE FALSE PREMISE COST
-- ============================================================================================
--
-- 20260829160000 widened order_line_events (from_state, to_state) to five values and stopped,
-- because on its own account there was nothing on order_lines to widen. So:
--
--   * order_line_events accepts 'collected'.
--   * order_lines rejects it, 23514.
--
-- Every 'Collected' / 'All collected' tap on either board therefore reached
-- app/api/station/order-lines/[lineId]/state/route.ts, passed every application-level check, and
-- died on the UPDATE with a constraint violation the route turns into a 500. The line never left
-- the Ready zone; the broadcast that tells the terminal is sent AFTER the update and was never
-- reached; and everything keyed on the state downstream -- bucketForLine, is_collected, and the
-- FOOD UP badge fix in app/api/terminal/tabs/[tabId]/lines/route.ts -- has been inert since it
-- shipped, waiting on a value that could not be stored.
--
-- Production's order_line_events, all time, at the moment this was written: 22 null->outstanding,
-- 12 outstanding->ready, 3 outstanding->cooked, 3 cooked->ready, and ZERO transitions to
-- 'collected'. Not "rarely used" -- never once successful.
--
-- ============================================================================================
-- ADDITIVE ONLY. NO DATA IS REWRITTEN.
-- ============================================================================================
--
-- Unlike 20260828141000 (which migrated 'done' -> 'ready' and had to), this widens a CHECK and
-- touches no row. Every value currently stored is still legal afterwards. In particular the
-- ready lines already sitting on production's boards are left exactly as they are -- they become
-- collectable through the application, which is the only way they should move.
--
-- The idiom is DROP CONSTRAINT IF EXISTS then ADD CONSTRAINT, matching 20260828235900 and
-- required by scripts/check-migration-inline-check.ts: both halves independently idempotent.

ALTER TABLE public.order_lines
  DROP CONSTRAINT IF EXISTS order_lines_kitchen_state_check;
ALTER TABLE public.order_lines
  ADD CONSTRAINT order_lines_kitchen_state_check
  CHECK (kitchen_state = ANY (ARRAY['outstanding'::text, 'cooked'::text, 'ready'::text, 'collected'::text, 'voided'::text]));

ALTER TABLE public.order_lines
  DROP CONSTRAINT IF EXISTS order_lines_bar_state_check;
ALTER TABLE public.order_lines
  ADD CONSTRAINT order_lines_bar_state_check
  CHECK (bar_state = ANY (ARRAY['outstanding'::text, 'cooked'::text, 'ready'::text, 'collected'::text, 'voided'::text]));

COMMENT ON COLUMN public.order_lines.kitchen_state IS
  'outstanding | cooked | ready | collected | voided. NULL when the kitchen does not own this line. The STATION writes cooked; the PASS writes ready; a runner or waiter picking the food up writes collected (20260829160000 for the concept, 20260831120000 for the constraint that finally permits it). ''done'' is retired -- accepted as an input alias and stored as ''ready''. NEVER index this with a WHERE predicate on a specific value: adding a state silently drops rows out of such an index with no error.';
COMMENT ON COLUMN public.order_lines.bar_state IS
  'See kitchen_state. Same five states, same actors.';
