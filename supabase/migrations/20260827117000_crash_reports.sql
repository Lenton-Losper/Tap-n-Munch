-- #348 -- automatic crash reports from App Router error boundaries.
--
-- NOT APPLIED BY THE AUTHORING AGENT. Written, committed, left for the deploy path to apply.
--
-- WHY A NEW TABLE AND NOT A COLUMN ON bug_reports.
--
--   bug_reports is the ops INBOX. Staff read their own venue's rows through RLS
--   (bug_reports_select_own_restaurant), /admin/bug-reports triages them, and every row in it
--   today is something a human chose to file. Three things follow, and each on its own is enough:
--
--     1. Its writer here would be ANONYMOUS. Letting an unauthenticated stranger write rows into
--        a table staff read is a content-injection surface pointed at staff, delivered by the
--        endpoint built to help them.
--     2. bug_reports.restaurant_id carries a FOREIGN KEY to restaurants (added by
--        20260724180000). A crash on a route we cannot parse a venue out of, or at a venue since
--        deleted, would fail the INSERT -- discarding the report over a field that is optional to
--        it. See the deliberate absence of that constraint below.
--     3. An automatic report arrives at the rate of the incident: one deploy that breaks a render
--        path produces one row per customer in the room. Mixing that into a human queue destroys
--        the human queue.
--
-- NO ROW LEVEL SECURITY POLICY IS GRANTED TO ANY ROLE, and that is the point rather than an
-- omission. RLS is enabled with no policy, so anon and authenticated can do nothing at all here.
-- The only writer is the service role used by app/api/crash-reports/route.ts, which bypasses RLS,
-- and the only readers are that same key and a human with database access. Nothing is granted to
-- `anon` because nothing on the customer surface ever reads this back -- the customer is told
-- their report was sent, not shown it.

create table if not exists public.crash_reports (
  id uuid primary key default gen_random_uuid(),

  -- Which boundary caught it, e.g. 'app/error.tsx' or 'app/(staff)/error.tsx'.
  boundary text,

  -- The reference shown on screen. Next's digest when there is one, else the FNV-1a fingerprint
  -- from lib/errors/report-boundary-error.ts. This is the string a venue reads out to us, so it
  -- is what makes a report findable from a phone call.
  reference text,
  digest text,

  error_name text,
  error_message text,
  error_stack text,

  -- PATH ONLY. app/api/crash-reports/route.ts discards origin, query and hash before this is
  -- written; see lib/crash-reports/crash-report-intake.ts, ruling 2. The customer surface puts a
  -- customer's name in ?name=, a party's tab in ?tabId=, and the gateway's return payload on
  -- /order-confirmation, none of which belongs in an ops table.
  page_path text,

  -- DERIVED from page_path, never accepted from the body -- an unauthenticated caller does not
  -- get to say which venue a report belongs to.
  --
  -- DELIBERATELY NOT A FOREIGN KEY, unlike bug_reports.restaurant_id. A FK here would make an
  -- unrecognised or deleted venue discard the crash report, which is the exact failure this
  -- endpoint exists to stop. Triage joins on it at read time and tolerates a miss.
  restaurant_id uuid,

  -- The one request header kept. For a RENDER crash the browser build is the most diagnostic
  -- non-code fact available, and it identifies a browser rather than a person. Truncated to 300
  -- characters at the route. No other header, no cookie, no session or tab token, and not the
  -- caller's IP -- the IP is used as a rate-limit bucket key for the length of the request and is
  -- never written here.
  user_agent text,

  -- True when the body hit the 32 KB ceiling or could not be parsed. The row still lands; this is
  -- how a reader knows the text above is a fragment rather than the whole thing.
  truncated boolean not null default false,

  created_at timestamptz not null default now()
);

-- Triage reads are "what came in recently", and "everything from this venue".
create index if not exists crash_reports_created_at_idx
  on public.crash_reports (created_at desc);

create index if not exists crash_reports_restaurant_created_idx
  on public.crash_reports (restaurant_id, created_at desc);

-- The same failure fingerprints to the same reference across venues (deliberately -- see
-- errorReference), so this is the index that turns one incident into one group.
create index if not exists crash_reports_reference_idx
  on public.crash_reports (reference);

alter table public.crash_reports enable row level security;

-- No policies. See the header: service role only.
