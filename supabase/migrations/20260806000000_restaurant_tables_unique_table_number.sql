-- Issue #174: restaurant_tables had NO unique constraint on (restaurant_id, table_number).
-- The only constraint was the primary key on `id`, so uniqueness rested entirely on one
-- application-level check in app/api/admin/tables/route.ts -- a read-then-write with no lock.
-- Two concurrent adds of the same number both pass that check and both insert.
--
-- This is not cosmetic: QR links resolve tables BY NUMBER (buildMenuUrl -> ?table=N), and
-- orders carry `table_number` rather than `table_id`. Two rows sharing a number would compete
-- to answer the same printed QR code, and would merge two physical tables in order history.
--
-- PARTIAL, on `table_number IS NOT NULL`: the pair is only meaningful for rows that have a
-- number. Neither environment has NULL numbers today, but the predicate keeps the index safe
-- if one ever appears rather than letting a single NULL row block the migration.
--
-- DELIBERATELY NOT scoped to `active = true`. A deactivated table keeps its number, because:
--   1. freeing it makes the deactivated row impossible to reactivate later without colliding;
--   2. deactivation removes the QR from the dashboard but NOT the printed card on the table,
--      so reissuing the number silently routes those customers to a different table;
--   3. orders resolve by number, so reuse merges two physical tables in historical data.
-- See #175, which keeps the same rule but makes the resulting collision explainable.
--
-- Not CONCURRENTLY: the table is tiny (16 rows on staging, 26 on production across 6
-- restaurants) so the brief lock is irrelevant, and CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block.
--
-- Verified NO duplicate (restaurant_id, table_number) pairs on either environment immediately
-- before applying, via scripts/check-duplicate-table-numbers-readonly.ts. This index cannot be
-- created while any duplicate exists.

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_tables_restaurant_id_table_number_key
  ON public.restaurant_tables (restaurant_id, table_number)
  WHERE table_number IS NOT NULL;
