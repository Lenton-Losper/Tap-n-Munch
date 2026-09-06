-- @env: both
--
-- Why a line was voided, recorded on the FULFILMENT event.
--
-- ============================================================================================
-- ON order_line_events, NOT ON order_lines. THE DISTINCTION IS THE POINT.
-- ============================================================================================
--
-- A LINE VOID IS A FULFILMENT FACT: this dish, at this moment, stopped being made. It belongs
-- with the other things that happened to that line over its life, which is what
-- order_line_events already is -- station, from_state, to_state, actor, occurred_at.
--
-- An ALLOCATION void is a MONEY fact and lives elsewhere. Same reason vocabulary, two tables,
-- deliberately: collapsing them would mean one row that is sometimes about a kitchen and
-- sometimes about a bill, and readers of each would have to filter the other out.
--
-- AND NOT `order_lines.line_note`, WHICH IS ALREADY TAKEN. That column is the KITCHEN PREP NOTE
-- -- "no onions" -- and `amend_order_lines` COPIES IT ONTO THE REPLACEMENT LINE
-- (20260829150000_amend_order_lines_function.sql:220). Writing a void reason there would put
-- "customer changed their mind" in front of a chef on the next amendment of the same dish.
--
-- ============================================================================================
-- SHAPE
-- ============================================================================================
--
-- NULLABLE, AND THAT IS NOT A LOOPHOLE. order_line_events records every state change a line
-- goes through, and almost none of them are voids -- a reason on a kitchen->ready transition
-- would be meaningless. The column is null for those, and the ROUTE requires it where it
-- applies. A NOT NULL here would force a reason onto every event this table has ever recorded.
--
-- FREE TEXT, NOT AN ENUM. The vocabulary is not settled yet, and a CHECK constraint written
-- before anyone has seen a month of real voids would be guessing at the categories -- and then
-- rejecting the reason a waiter actually needed to give. Trimmed and length-capped at the route.
--
-- No data is written: existing events keep a null reason, which correctly reads as "not
-- recorded", never as "no reason given".

ALTER TABLE public.order_line_events
  ADD COLUMN IF NOT EXISTS void_reason text;

COMMENT ON COLUMN public.order_line_events.void_reason IS
  'Why a line was voided. Null on every event that is not a void, and on voids recorded before '
  'this column existed -- null means NOT RECORDED, never "no reason given". A line void is a '
  'fulfilment fact; an allocation void is a money fact and is recorded separately. Never use '
  'order_lines.line_note for this: that is the kitchen prep note and amend_order_lines copies it '
  'onto the replacement line.';
