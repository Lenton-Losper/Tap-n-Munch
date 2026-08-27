-- @env: both
--
-- #193 — record the REAL restaurant_terminals.status vocabulary, because the migration history
-- misrepresents it. NO CONSTRAINT IS ADDED, ALTERED OR DROPPED. Comment only.
--
-- WHAT WAS WRONG. Two migrations declare contradictory closed sets for this column:
--
--   baseline                              active | inactive | revoked | pending
--   20260620150000_terminal_api_layer     active | revoked  | maintenance | pending_update
--
-- They disagree on three of four members, and the second NEVER TOOK EFFECT: it declares the column
-- with `ADD COLUMN IF NOT EXISTS` on a column the baseline had already created, so the IF NOT
-- EXISTS short-circuited and the whole clause -- inline CHECK included -- was silently skipped.
-- A migration that appears to tighten a constraint and does nothing at all.
--
-- MEASURED ON PRODUCTION 2026-08-27, from pg_constraint rather than from the files:
--
--   live constraint   CHECK (status = ANY (ARRAY['active','inactive','revoked','pending']))
--   values in use     active (84), pending (15).  Nothing else exists.
--
-- So the BASELINE won, and `maintenance` / `pending_update` exist in no constraint and no row.
--
-- OWNER RULING 2026-08-27: keep the live four, do not migrate to the newer set. Migrating would
-- BREAK `inactive`, which application code actually writes -- the newer vocabulary omits the one
-- value in daily use and adds three that nothing has ever written. This is a documentation fault,
-- not a schema fault, and the correct fix is to make the documentation match the database rather
-- than the reverse.
--
-- WHY THE 20260620150000 FILE IS NOT EDITED. It has been applied in every environment and its
-- version is recorded in each ledger. Rewriting an applied migration to remove a clause that never
-- ran changes nothing in any database while making the historical record disagree with what was
-- actually executed. The dead clause is left where it is and named here instead, which is the
-- record a future reader needs: not "this was always four values" but "a second file claimed
-- otherwise, silently failed, and here is how we know".
--
-- THE PATTERN UNDERNEATH, measured rather than assumed. 5 inline CHECKs and 12 inline FKs are
-- attached to `ADD COLUMN IF NOT EXISTS` across the migration set. Sampled against production:
-- every FK applied, and 3 of the 5 CHECKs applied (2 target tables that do not exist here). The
-- short-circuit only bites when the column ALREADY EXISTS, which is why this column is the one
-- instance that broke. The blast radius today is one constraint -- but nothing detects the shape,
-- and `check-migration-inline-check` does not cover the FK form at all.

COMMENT ON COLUMN public.restaurant_terminals.status IS
  'Closed set, enforced by restaurant_terminals_status_check: active | inactive | revoked | '
  'pending. Application code writes only `active` and `inactive`. '
  'DO NOT trust 20260620150000_terminal_api_layer.sql, which declares a DIFFERENT vocabulary '
  '(active | revoked | maintenance | pending_update) that NEVER APPLIED -- its ADD COLUMN IF NOT '
  'EXISTS short-circuited on a column the baseline had already created, taking its inline CHECK '
  'with it. `maintenance` and `pending_update` exist in no constraint and no row. Verified against '
  'production pg_constraint on 2026-08-27 (#193).';
