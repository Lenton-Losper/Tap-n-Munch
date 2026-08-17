-- The missing half of the order_requests <-> orders relationship.
--
-- RULED 2026-08-16. `order_requests.accepted_order_id` records the forward link, and nothing
-- records the reverse: an `orders` row carries no indication that it was created from a request.
-- That is not merely inconvenient for summing a tab -- it means the relationship can only ever be
-- reconstructed by inference, matching on timestamp and total, which is guessing at a financial
-- link. A wrong guess there becomes invisible truth.
--
-- So this is the missing half of a relationship, not a workaround for one.
--
-- WHY THIS IS THE ATOMIC HALF. `createOrder` writes the order in a single INSERT
-- (lib/orders/create-order.ts:91). Putting the link ON that row means it is written by the same
-- statement that creates the order -- there is no window in which the order exists without it,
-- and no transaction is required to achieve that. The reverse link is a separate UPDATE in the
-- Accept route and remains non-atomic with the insert; the two are therefore allowed to disagree,
-- which is precisely why an assertion that they agree is worth having.
--
-- NO INLINE CHECK, deliberately: an inline CHECK on ADD COLUMN IF NOT EXISTS is silently skipped
-- when the column already exists (#212), and scripts/check-migration-inline-check.ts rejects the
-- pattern outright.
--
-- NULLABLE, and it must stay nullable. Most orders do not come from a request at all -- the
-- terminal/POS route calls createOrder directly, and every order predating the Order Request model
-- has no request to point at. NULL means "not from a request", never "link missing".
--
-- NOT BACKFILLED. Existing rows keep NULL. Reconstructing the link for historical orders would
-- mean inferring it, which is the thing this column exists to make unnecessary.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS source_request_id uuid REFERENCES public.order_requests(id);

COMMENT ON COLUMN public.orders.source_request_id IS
  'The order_request this order was created from, written by the same INSERT that creates the order. NULL means the order did not come from a request (terminal/POS, or predating the Order Request model) -- never that the link is missing. The mirror of order_requests.accepted_order_id; the two must agree.';

-- Reverse lookups are "given this request, did an order already come from it?", which is the
-- question the pending total and the consistency check both ask.
CREATE INDEX IF NOT EXISTS orders_source_request_id_idx
  ON public.orders (source_request_id)
  WHERE source_request_id IS NOT NULL;
