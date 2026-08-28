-- 'collected' — the fifth state. A pinned Ready zone needs a way to clear, or a line stays
-- 'ready' forever and the zone that was supposed to stay pinned and trustworthy fills with food
-- that already left the pass.
--
-- ============================================================================================
-- WHY A PER-LINE COLUMN VALUE, NOT EVENT-ONLY
-- ============================================================================================
--
-- Ruled: "a per-line column not event-only — a state you can only answer by reading the events
-- table is a state nobody reads." order_lines.kitchen_state/bar_state ARE that per-line column
-- already, for every other transition (outstanding/cooked/ready/voided) — 'collected' becomes a
-- fifth value on the SAME two columns, not a new table or a new column. GET /api/station/lines
-- already reads kitchen_state/bar_state directly for its board query; a caller asking "is this
-- line collected" gets the answer from the same place it already asks "is this line ready",
-- with no join to order_line_events required.
--
-- order_line_events keeps recording the TRANSITION (occurred_at, actor) for the same reason it
-- already records every other one — audit trail, not the source of current truth.
--
-- ============================================================================================
-- WHY THE CHECK CONSTRAINTS ARE WIDENED HERE AND order_lines ITSELF IS NOT
-- ============================================================================================
--
-- order_lines.kitchen_state/bar_state carry no CHECK constraint today (confirmed against
-- production 2026-08-28) -- free text, validated only by what application code writes. The two
-- CHECK constraints that DO exist and DO need widening are on order_line_events
-- (order_line_events_from_state_check, order_line_events_to_state_check) -- both name the same
-- four-value array, and 'collected' must be added to both or a collected transition's own audit
-- row fails to insert.

ALTER TABLE public.order_line_events
  DROP CONSTRAINT order_line_events_from_state_check;
ALTER TABLE public.order_line_events
  ADD CONSTRAINT order_line_events_from_state_check
  CHECK (from_state = ANY (ARRAY['outstanding'::text, 'cooked'::text, 'ready'::text, 'collected'::text, 'voided'::text]));

ALTER TABLE public.order_line_events
  DROP CONSTRAINT order_line_events_to_state_check;
ALTER TABLE public.order_line_events
  ADD CONSTRAINT order_line_events_to_state_check
  CHECK (to_state = ANY (ARRAY['outstanding'::text, 'cooked'::text, 'ready'::text, 'collected'::text, 'voided'::text]));
