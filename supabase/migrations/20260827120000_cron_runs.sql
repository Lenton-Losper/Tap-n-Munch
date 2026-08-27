-- @env: both
--
-- #156 — a scheduled job must be able to say "I ran and found nothing".
--
-- THE GAP THIS CLOSES. The hourly card-payments-without-sale-row sweep is detection-only and
-- persists nothing. A run that scans 40 payments and finds 0 missing writes exactly what a run
-- that never happened writes: nothing at all. So "is the sweep running?" is unanswerable from the
-- database, and the only trace is a console line in a Worker.
--
-- That is the same defect the sweep itself exists to report on. #156's whole lesson is that an
-- instrument nobody can read is not an instrument -- the ledger died for a month behind a
-- console.error on a terminal in a restaurant. A sweep that reports only to Worker logs is that
-- shape one level up, and it is the reason "all clear" keeps getting shipped unverified while
-- "it's present" gets checked.
--
-- WHY A NEW TABLE AND NOT audit_logs. `audit_logs.restaurant_id` is NOT NULL, and a cron heartbeat
-- has no venue. The only ways to force it in are a schema change to that table or a sentinel
-- restaurant id -- and the sentinel is out on the evidence of #324, where 1,314 rows carrying a
-- placeholder tenant poisoned every denominator that touched `orders` and produced a fabricated
-- "876 broken QR orders" incident. A row that pretends to belong to a venue is a row that will be
-- counted as one.
--
-- WHAT IT IS NOT. Not a log, not a queue, not a lock. One row per completed scan, holding the
-- numbers that scan produced. It grants no new capability to any cron and must never be read to
-- decide whether to DO something -- a job that reads its own heartbeat to choose behaviour has
-- turned an observation into state, and then the observation can break the job.
--
-- FORWARD-ONLY AND ADDITIVE. New table, nothing altered, nothing backfilled. Dropping it removes
-- the visibility and breaks nothing.

CREATE TABLE IF NOT EXISTS public.cron_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The cron route's own path segment, e.g. 'card-payments-without-sale-row'. Deliberately the
  -- route name and not a free-text label: it is the thing you grep for when a job goes quiet.
  job         text        NOT NULL,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  -- How many rows the scan CONSIDERED. `scanned = 0` is the load-bearing value: it means the job
  -- ran and had nothing to look at, which is a completely different fact from `findings = 0`
  -- (it ran, it looked, everything was fine) and from no row at all (it did not run). Collapsing
  -- those three is precisely the confusion this table exists to prevent.
  scanned     integer     NOT NULL DEFAULT 0,
  -- How many of the scanned rows were problems. NULL means the scan could not complete, which is
  -- again distinct from 0.
  findings    integer,
  -- Anything job-specific worth keeping: the worst offenders, a ratio, an error message.
  detail      jsonb,
  CONSTRAINT cron_runs_scanned_non_negative  CHECK (scanned >= 0),
  CONSTRAINT cron_runs_findings_non_negative CHECK (findings IS NULL OR findings >= 0),
  -- findings can never exceed what was looked at. A job reporting 5 findings from 3 scanned rows
  -- is miscounting, and a heartbeat that can lie about its own arithmetic is worse than absent.
  CONSTRAINT cron_runs_findings_within_scanned CHECK (findings IS NULL OR findings <= scanned)
);

-- The only query this table is for: "when did <job> last run, and what did it see?"
CREATE INDEX IF NOT EXISTS cron_runs_job_ran_at_idx
  ON public.cron_runs (job, ran_at DESC);

-- RLS on, with NO policy. Every writer is the service-role client inside a cron route, which
-- bypasses RLS; every reader is an operator on a direct connection. Leaving RLS off would expose
-- operational timing to `anon` for no reason -- and #284 is this month's reminder that an
-- anon-readable table nobody meant to expose is easy to create and hard to notice.
ALTER TABLE public.cron_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.cron_runs IS
  'One row per completed scheduled-job run. Exists so "the job found nothing" and "the job never '
  'ran" stop being the same observation (#156). Written by cron routes via the service-role '
  'client; RLS is enabled with no policy, so anon and authenticated cannot read it. Never read '
  'this to decide whether to perform work -- it is an observation, not state.';
