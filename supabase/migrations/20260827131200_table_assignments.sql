-- ADR-005 §3 -- which waiter owns a table, and which waiter owned it last Tuesday.
--
-- NOT APPLIED BY THE AUTHORING AGENT. Written, committed, left for the deploy path to apply.
--
-- ============================================================================================
-- WHY HISTORY AND NOT A CURRENT-OWNER COLUMN ON restaurant_tables
-- ============================================================================================
--
-- A waiter_id column on restaurant_tables would answer "who has table 12 right now" and nothing
-- else. It was rejected for two reasons, and the second is the one that matters:
--
--   1. Someone asks "who had table 12 last Tuesday" the first week this ships, and a column that
--      was overwritten at every handover cannot answer it at all.
--   2. MONEY. ADR-005 §6 attributes a tip to the waiter who OPENED the tab. If tip attribution
--      read through a mutable current-owner column, a handover at 21:00 would retroactively move
--      every tip earned on that table since 18:00 to whoever happened to be standing there. A
--      shift change would quietly reassign other people's money.
--
-- Point 2 is also why this table is NOT the tip anchor. See the split below.
--
-- ============================================================================================
-- TWO ANCHORS, DELIBERATELY, BECAUSE THEY ANSWER DIFFERENT QUESTIONS
-- ============================================================================================
--
--   THIS TABLE            -- who is responsible for this table right now, and who has been.
--                            Mutable over time. An OPERATIONS fact.
--
--   tabs.opened_by_staff_id -- who served this tab. Snapshotted once at open, immutable
--                            thereafter (20260827131300). A MONEY fact.
--
-- Collapsing them into one is exactly the bug described above. They are allowed to disagree, and
-- when they do, the disagreement is the correct answer rather than an inconsistency to reconcile:
-- the tab belongs to whoever opened it even though the table now belongs to someone else.
--
-- ============================================================================================
-- OPEN INTERVALS, NOT A STATUS
-- ============================================================================================
--
-- The current assignment is the row with released_at IS NULL. There is no 'active' flag, because a
-- flag and a released_at can contradict each other and then nobody knows which one lies. One
-- representation, enforced by the partial unique index below: a table has at most one open
-- assignment at a time.
--
-- Reassignment is release-then-assign, two rows, both preserved. Nothing is ever overwritten.
--
-- ============================================================================================
-- EVENT F IS NOT DECIDED HERE
-- ============================================================================================
--
-- "A waiter is assigned to a table; a different waiter tries to add to it" is ADR-005 §8.3, still
-- open. This schema deliberately does NOT enforce an answer: there is no constraint tying an order
-- to the table's current assignee. A hard block belongs in the route if it is ruled at all, never
-- in the schema, because a schema-level block strands a table when a waiter goes on break and
-- there is no way to override it at 20:00 on a Friday.
--
-- Whichever way §8.3 is ruled, tip attribution is unaffected -- it follows the tab's opening
-- owner, not whoever wrote the line.

CREATE TABLE IF NOT EXISTS public.table_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

  table_id uuid NOT NULL REFERENCES public.restaurant_tables(id) ON DELETE CASCADE,

  -- The waiter. NOT NULL: an assignment to nobody is not an assignment, it is a released table,
  -- which is represented by released_at rather than by a null owner.
  --
  -- FK TARGET TO CONFIRM AT BUILD TIME: staff_members carries role 'waiter', so it is the right
  -- identity. But the staff PIN driving cash attribution today could not be located in the
  -- migration history, and if that path resolves to a different identity, this column moves to
  -- match it rather than standing up a second parallel notion of "who served".
  staff_id uuid NOT NULL REFERENCES public.staff_members(id) ON DELETE RESTRICT,

  assigned_at timestamptz NOT NULL DEFAULT now(),

  -- NULL means this is the current assignment. See the header: no status flag.
  released_at timestamptz,

  -- Who made the assignment -- a manager assigning sections, or the waiter claiming the table.
  -- Nullable: a system-seeded assignment has nobody behind it.
  assigned_by uuid REFERENCES public.staff_members(id) ON DELETE SET NULL,

  -- A release cannot precede the assignment it releases.
  CONSTRAINT table_assignments_interval_ordered
    CHECK (released_at IS NULL OR released_at >= assigned_at)
);

COMMENT ON TABLE public.table_assignments IS
  'ADR-005 §3: who owns a table, over time. Open interval -- the current assignment is the row with released_at IS NULL. Deliberately NOT the tip anchor: tips follow tabs.opened_by_staff_id, so that a shift handover cannot retroactively reassign money already earned.';

COMMENT ON COLUMN public.table_assignments.released_at IS
  'NULL means current. There is no ''active'' flag on purpose -- a flag and a timestamp can contradict each other, and then neither can be trusted.';

COMMENT ON COLUMN public.table_assignments.staff_id IS
  'ON DELETE RESTRICT, unlike the audit tables: deleting a staff member who currently holds tables should fail loudly and be resolved by releasing them, not by silently orphaning live assignments mid-service.';

-- ONE OPEN ASSIGNMENT PER TABLE. The invariant the open-interval representation depends on --
-- without it, two overlapping unreleased rows make "who has table 12" ambiguous and there is no
-- way to tell which is stale.
CREATE UNIQUE INDEX IF NOT EXISTS table_assignments_one_open_per_table_idx
  ON public.table_assignments (table_id)
  WHERE released_at IS NULL;

-- "Which tables are mine right now" -- the waiter's home screen on the P5.
CREATE INDEX IF NOT EXISTS table_assignments_open_by_staff_idx
  ON public.table_assignments (restaurant_id, staff_id)
  WHERE released_at IS NULL;

-- "Who had table 12 last Tuesday" -- the history read this table exists for.
CREATE INDEX IF NOT EXISTS table_assignments_table_history_idx
  ON public.table_assignments (table_id, assigned_at DESC);

-- ---------------------------------------------------------------------------
-- RLS: staff with tables:read may read. Every write is service role.
-- ---------------------------------------------------------------------------
ALTER TABLE public.table_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized staff can read table assignments" ON public.table_assignments;
CREATE POLICY "Authorized staff can read table assignments"
  ON public.table_assignments
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'tables:read'));
