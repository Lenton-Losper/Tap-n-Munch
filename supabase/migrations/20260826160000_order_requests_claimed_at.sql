-- @env: both
--
-- #215 — `order_requests` HAS NO REAPER, AND CANNOT HAVE ONE UNTIL THE CLAIM RECORDS A TIME.
--
-- POST /api/order-requests/{id}/accept claims a row by setting status='accepting' before it calls
-- createOrder(). Nothing on that path is transactional — the claim, the orders insert and the
-- finalize are three separate PostgREST round-trips — so a row is left in 'accepting' PERMANENTLY
-- if the release UPDATE fails or the worker dies between the claim and either exit.
--
-- Since #120 that is not merely untidy: `LIVE_REQUEST_STATUSES = ['waiting_review','accepting']`
-- BLOCKS settle and close, so a stranded claim holds a bill open and staff cannot close the table.
--
-- WHY THE COLUMN COMES FIRST. The table has `placed_at`, `decided_at`, `decided_by` and nothing
-- recording when the row entered 'accepting'. `placed_at` is the CUSTOMER's submission time — a
-- request can legitimately sit in waiting_review for an hour before staff press Accept — so a
-- reaper keyed on it would kill Accepts that started 200ms ago on old requests. Staleness is not
-- expressible against the current schema. This migration is the prerequisite, not the fix.
--
-- ============================================================================================
-- WHY A TRIGGER AS WELL AS THE ROUTE'S OWN WRITE
-- ============================================================================================
--
-- The accept route now writes `claimed_at` in the same UPDATE that takes the claim, which is
-- where a reader looks for it. That alone is not enough, because of DEPLOY ORDER: migrations are
-- applied BEFORE the worker that uses them ships (the drift gate requires it). In that window the
-- old worker still writes a bare `{ status: 'accepting' }`, and any row it stranded would carry
-- claimed_at = NULL — un-aged, therefore un-reapable, forever. That is this exact bug reintroduced
-- by the fix for it.
--
-- So the stamp is enforced where the write happens. Entry into 'accepting' cannot be expressed
-- without a time: the trigger overwrites whatever the caller supplied with the DATABASE clock,
-- which also removes worker clock skew as an input to a destructive decision. Same posture as
-- reap_abandoned_tab keeping the money guard inside the function rather than in its caller's
-- WHERE clause — the omission has to be unexpressible, not merely remembered.
--
-- It fires only on ENTRY (OLD.status IS DISTINCT FROM 'accepting'), so a later UPDATE that leaves
-- a row in 'accepting' does not refresh the clock and postpone its own reaping.
--
-- claimed_at is NOT cleared on the way out. A released row gets a fresh stamp on its next claim
-- (it re-enters from waiting_review), and on an accepted row the value is a record of how long
-- the accept took. Nothing reads it except while status = 'accepting'.
--
-- ============================================================================================
-- THE BACKFILL, AND WHY now() RATHER THAN placed_at
-- ============================================================================================
--
-- Rows already sitting in 'accepting' when this is applied have no recorded claim time and no way
-- to recover one. `placed_at` is available and is the tempting answer; it is wrong, because it is
-- a LOWER bound on the claim, so using it makes every such row look older than it is — and the
-- one row that might be a live in-flight accept at the instant of application is exactly the row
-- that would be mis-aged.
--
-- now() cannot mis-age anything. It gives every pre-existing stranded row the full grace window
-- and no more, so the backlog clears one window after deployment, and a live accept in flight is
-- untouchable. The reaper records `placed_at` in its audit row, so the true age of the underlying
-- request is still visible to anyone reading later.
--
-- Forward-only and additive: one nullable column, one partial index, one trigger. Rolling back
-- means dropping the trigger and the column; nothing else reads either.

ALTER TABLE public.order_requests
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

COMMENT ON COLUMN public.order_requests.claimed_at IS
  'When this row entered the transient ''accepting'' claim, stamped from the database clock by '
  'order_requests_stamp_claimed_at(). Meaningful only while status = ''accepting''; it is what '
  'makes a stranded claim distinguishable from one taken 200ms ago, and therefore what makes the '
  '#215 reaper possible at all. NEVER use placed_at for this -- that is the customer''s submission '
  'time and a request may legitimately wait in review for hours.';

-- The reaper's candidate query is exactly (status = 'accepting' AND claimed_at < cutoff), and the
-- partial predicate keeps the index the size of the stranded set rather than the whole table.
CREATE INDEX IF NOT EXISTS order_requests_accepting_claimed_at_idx
  ON public.order_requests (claimed_at)
  WHERE status = 'accepting';

CREATE OR REPLACE FUNCTION "public"."order_requests_stamp_claimed_at"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    -- Entry into the claim only. A row that was already 'accepting' keeps its original stamp:
    -- refreshing it on every touch would let an unrelated UPDATE postpone the reap indefinitely.
    IF NEW.status = 'accepting' AND OLD.status IS DISTINCT FROM 'accepting' THEN
        NEW.claimed_at := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_requests_stamp_claimed_at_trg ON public.order_requests;
CREATE TRIGGER order_requests_stamp_claimed_at_trg
  BEFORE UPDATE ON public.order_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.order_requests_stamp_claimed_at();

COMMENT ON FUNCTION "public"."order_requests_stamp_claimed_at"() IS
  'Stamps order_requests.claimed_at from the database clock on entry into ''accepting''. Exists so '
  'that a claim taken by ANY writer -- including a worker deployed before this migration, which '
  'sends a bare { status: ''accepting'' } -- is aged and therefore reapable. See #215.';

-- Pre-existing stranded rows. See the header for why now() and not placed_at.
UPDATE public.order_requests
   SET claimed_at = now()
 WHERE status = 'accepting'
   AND claimed_at IS NULL;
