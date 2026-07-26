-- Adds a transient 'accepting' status so Accept can atomically claim the request row
-- BEFORE calling createOrder(), closing a real bug found in the 2026-07-26 audit: the
-- prior atomic-claim fix moved status -> 'accepted' only AFTER createOrder() returned,
-- so a losing Accept (racing a concurrent Decline) could already have created a real,
-- orphaned `orders` row by the time its claim attempt discovered it had lost.
--
-- 'accepting' can't be skipped by claiming straight into 'accepted': the existing
-- order_requests_accepted_has_order CHECK requires accepted_order_id IS NOT NULL whenever
-- status = 'accepted', and accepted_order_id has an FK to orders(id) -- both of which are
-- only satisfiable once a real order already exists. 'accepting' has no such requirement,
-- so it can be claimed first, then finalized into 'accepted' once createOrder() succeeds
-- (or released back to 'waiting_review' if createOrder() fails).
ALTER TABLE public.order_requests DROP CONSTRAINT order_requests_status_check;
ALTER TABLE public.order_requests ADD CONSTRAINT order_requests_status_check
  CHECK (status = ANY (ARRAY['waiting_review'::text, 'accepting'::text, 'accepted'::text, 'declined'::text]));
