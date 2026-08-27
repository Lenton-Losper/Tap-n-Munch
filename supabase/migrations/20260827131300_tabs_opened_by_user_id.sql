-- ADR-005 §3 and §6 -- who served this tab. The tip anchor.
--
-- NOT APPLIED BY THE AUTHORING AGENT. Written, committed, left for the deploy path to apply.
--
-- ============================================================================================
-- WHY THIS IS A SNAPSHOT AND NOT A LOOKUP
-- ============================================================================================
--
-- ADR-005 §6, ruling 2: a tip is attributed to the waiter assigned WHEN THE TAB OPENED. That is
-- who served them. A shift change mid-meal does not transfer the tip to whoever happened to be
-- standing there at settle.
--
-- service_table_assignments (20260827131200) already records who owns a table over time, so this column
-- looks redundant. It is not, and the difference is money:
--
--   Ana opens table 12's tab at 18:00. She goes off shift at 21:00 and Ben takes the section.
--   The table settles at 21:30 with a tip.
--
-- Resolved through service_table_assignments at settle time, that tip goes to Ben, who did not serve them.
-- Resolved through a value frozen at 18:00, it goes to Ana, who did. A JOIN cannot be made to
-- return the second answer without reconstructing "what was true at 18:00", and a reconstruction
-- is exactly the thing that breaks quietly when the assignment history is edited, backfilled, or
-- has a gap.
--
-- THIS COLUMN IS WRITTEN ONCE, AT TAB CREATION, AND NEVER UPDATED. Not enforced by a trigger
-- because the write path is a single service-role route and a trigger here would be a second place
-- to look when something goes wrong; enforced by the fact that nothing else is allowed to write it.
--
-- ============================================================================================
-- NULLABLE, BECAUSE MOST TABS HAVE NO WAITER
-- ============================================================================================
--
-- Tabs are live at Mingle and ChowNow today, created by customers scanning a QR code. Those tabs
-- have no waiter and never will. NOT NULL would require inventing an attribution for every
-- existing tab and every future QR tab -- a fabricated fact, written into a money column.
--
-- NULL here means "no waiter served this tab", which is true, checkable, and different from
-- "we do not know". Tip attribution reads it directly: a null owner means a tip on that tab has
-- nobody to attribute to, which is a real situation the reports must show rather than guess at.
--
-- NO BACKFILL of existing tabs. There is no waiter to backfill them with.

-- FK TARGET CONFIRMED 2026-08-27: users.id, not staff_members.id -- the terminal PIN flow resolves
-- to a users.id via terminal_authorization_credentials.user_id. See 20260827131100.
--
-- NO INLINE CHECK ON THIS ADD COLUMN, deliberately: `IF NOT EXISTS` makes the action idempotent
-- WITH its constraint, so on a database where the column already exists the constraint would
-- silently never be created while the migration reported success (#212). There is no CHECK to add
-- here, and none should be added later this way.
ALTER TABLE public.tabs
  ADD COLUMN IF NOT EXISTS opened_by_user_id uuid
    REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.tabs.opened_by_user_id IS
  'ADR-005 §6: the waiter who opened this tab, snapshotted at creation and never updated. The tip anchor. users.id, the identity the terminal PIN flow produces. Deliberately NOT resolved through service_table_assignments at settle time -- a shift handover would otherwise move an earned tip to whoever was standing there. NULL for customer-opened (QR) tabs, which is a fact rather than a gap.';

-- "Which tabs did this waiter open" -- per-waiter tip and service reporting (ADR-005 §6 ruling 4).
-- Partial: every pre-existing tab and every QR tab is null, and none of them are ever the answer
-- to this question.
CREATE INDEX IF NOT EXISTS tabs_opened_by_user_idx
  ON public.tabs (restaurant_id, opened_by_user_id, created_at DESC)
  WHERE opened_by_user_id IS NOT NULL;
