-- Close out tabs that were resurrected after being settled.
--
-- Background. The terminal settle route used to reopen a tab unconditionally at the end of
-- the request. A tab closed via close_table_session carries status='settled' with settled_at
-- and settled_type set; flipping it back to 'open' produced a contradictory row -- open, yet
-- settled minutes earlier -- and re-armed the partial unique index
--   idx_tabs_one_open_per_table UNIQUE (restaurant_id, table_number) WHERE status = 'open'
-- With an 'open' row present, a fresh insert for that table is impossible, so POST /api/tabs
-- hit 23505 and silently degraded into a JOIN, handing the next customer the previous party's
-- tab: their display name, session id, itemised order and receipt, with the tab PIN bypassed.
--
-- The application fix guards both the reopen and the join branch. But it does NOT repair rows
-- that are ALREADY in this state, and for those the fix alone makes things worse in a
-- different way: the insert still hits 23505, the now-guarded join correctly matches nothing,
-- and the handler returns 409 "Table already has an open tab" on every subsequent scan. The
-- table becomes unusable, and because restaurant_tables.status is left 'available' staff
-- cannot see that anything is wrong. Safe, but silently broken.
--
-- This migration returns those rows to the state they should have been left in by the close.
-- It targets exactly the contradictory shape and nothing else: a row can only match if it is
-- marked open while carrying a settlement timestamp, which no correct code path produces.
-- After the application fix no new rows can enter this state, so this runs once and is
-- thereafter a no-op. It is idempotent and safe to re-run.
--
-- Deliberately NOT touched:
--   * orders on these tabs -- their payment_status is already correct and settling them here
--     would be exactly the kind of fabrication the surrounding work exists to remove.
--   * restaurant_tables.status -- close_table_session already set it, and rewriting it from a
--     migration could contradict a table that has since been legitimately reoccupied.
--   * settled_at / settled_type -- preserved as the historical record of the original close.

UPDATE public.tabs
SET status = 'settled'
WHERE status = 'open'
  AND settled_at IS NOT NULL;
