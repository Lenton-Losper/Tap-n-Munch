-- Customer order editing, before preparation starts.
--
-- RULING (human, 2026-08-13): a customer may edit an order only before preparation
-- starts; once preparing, editing is closed permanently for that order. The lock lives
-- in the DATABASE, because the case that matters is two staff devices plus a customer
-- phone -- a browser guard is not a lock. On simultaneous fire STAFF WINS: an order the
-- kitchen has started must never change underneath the kitchen.
--
-- HOW STAFF WINS, mechanically. Every customer commit is conditioned on
-- `edit_lock_token = <the token the customer holds>` in the UPDATE's own WHERE clause.
-- PATCH /api/orders/[orderId]/status NULLS that token whenever it moves an order out of
-- the editable set (see EDITABLE_ORDER_STATUSES in lib/orders/edit-lock.ts). So the staff
-- transition to `preparing` invalidates any customer edit already in flight, at the
-- database, without the status route having to know anything about the customer's request.
-- There is no reverse case: an open edit lock never blocks a staff status change.
--
-- WHY A TOKEN AND NOT A BOOLEAN. The token is what makes the commit a compare-and-set
-- rather than a claim of intent. A boolean `is_being_edited` cannot distinguish "the lock I
-- took" from "the lock somebody else took after mine expired", so two customers on the same
-- table could both commit against the same order. Same reasoning as the existing status CAS
-- at app/api/orders/[orderId]/status/route.ts.
--
-- EXPIRY. edit_lock_expires_at is set 3 minutes out (EDIT_LOCK_TTL_MS) so an abandoned cart
-- cannot hold an order hostage against the OTHER customers at the table, and so the
-- dashboard's "customer is editing" indicator clears itself. Expiry is evaluated in the
-- application against the row's own timestamp; nothing sweeps this table.
--
-- No CHECK constraints here, deliberately: an inline CHECK on ADD COLUMN IF NOT EXISTS is
-- silently skipped when the column already exists (#212), and the CI gate
-- scripts/check-migration-inline-check.ts rejects the pattern outright.

-- ---------------------------------------------------------------------------
-- orders: the post-Accept surface. Editable while status is pending/accepted.
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS edit_lock_token uuid,
  ADD COLUMN IF NOT EXISTS edit_lock_session_id text,
  ADD COLUMN IF NOT EXISTS edit_lock_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_edit_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_before_edit numeric,
  ADD COLUMN IF NOT EXISTS requires_reacceptance boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS edit_history jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.orders.edit_lock_token IS
  'Opaque holder token for an open customer edit. The customer commit UPDATE is conditioned on it; the staff status route nulls it when the order leaves the editable set. NULL = no edit open.';
COMMENT ON COLUMN public.orders.total_before_edit IS
  'The total immediately before the most recent total-changing customer edit. Feeds the dashboard before/after figure; never used for pricing.';
COMMENT ON COLUMN public.orders.requires_reacceptance IS
  'Set when a customer edit changed the total. The order is returned to `pending` so staff re-accept it against the new figure.';
COMMENT ON COLUMN public.orders.edit_history IS
  'Append-only JSONB log of customer edits: {edited_at, previous_total, new_total, previous_items, reason}. The audit trail of what the customer originally ordered.';

-- ---------------------------------------------------------------------------
-- order_requests: the pre-Accept surface. A QR submission lives here until staff
-- Accept, which is the window a customer is most likely to want to change something.
--
-- The customer amendment gets its OWN columns rather than mutating items/subtotal/tax/
-- total. That is not tidiness: 20260726100000_order_requests.sql records, in the table
-- definition itself, that those columns are "never mutated after insert (audit trail)".
-- That is a decision already made by someone who is not here to defend it, so it is
-- honoured. Effective pricing precedence is resolved in one place --
-- lib/orders/order-request-pricing.ts -- and is reviewed ?? customer ?? original, i.e.
-- the most recent writer wins. A customer edit nulls any stale staff review (preserving
-- it in edit_history) because Accept reads items_reviewed FIRST, so leaving one in place
-- would silently discard the customer's change and charge them for an item they removed.
-- ---------------------------------------------------------------------------
ALTER TABLE public.order_requests
  ADD COLUMN IF NOT EXISTS items_customer jsonb,
  ADD COLUMN IF NOT EXISTS subtotal_customer numeric,
  ADD COLUMN IF NOT EXISTS tax_customer numeric,
  ADD COLUMN IF NOT EXISTS total_customer numeric,
  ADD COLUMN IF NOT EXISTS edit_lock_token uuid,
  ADD COLUMN IF NOT EXISTS edit_lock_session_id text,
  ADD COLUMN IF NOT EXISTS edit_lock_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_edit_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_before_edit numeric,
  ADD COLUMN IF NOT EXISTS requires_reacceptance boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS edit_history jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.order_requests.items_customer IS
  'The customer''s own amendment to their submission, priced server-side. NULL until the customer edits. Precedence is items_reviewed ?? items_customer ?? items -- see lib/orders/order-request-pricing.ts.';
COMMENT ON COLUMN public.order_requests.requires_reacceptance IS
  'Set when a customer edit invalidated a saved staff review. The Waiting for Review card tells staff to look again.';
