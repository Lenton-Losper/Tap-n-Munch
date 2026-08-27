-- @env: both
--
-- #324 — MAKE "THIS ROW IS STRESS-TEST DEBRIS" A FACT THE DATABASE STATES, NOT A FILTER EVERY
-- AUTHOR HAS TO REMEMBER. Additive, forward-only, and it TOUCHES NO EXISTING VALUE.
--
-- ============================================================================================
-- WHAT IS IN THE TABLE, MEASURED READ-ONLY ON PRODUCTION 2026-08-27
-- ============================================================================================
--
--     orders, all rows                                                3522
--     restaurant_id IS NULL                                           1315
--       of which firebase_restaurant_id LIKE 'restaurant_test_%'      1314   <- the fixtures
--       of which firebase_restaurant_id IS NULL                          1   <- NOT a fixture
--     real orders                                                     2208
--
-- The 1,314 are one run of `flashtap-stress-test.js` on 2026-04-27, tailing off to 2026-06-16.
-- Nine fake venues at exactly 146 rows each. Every one of them: status 'completed',
-- payment_status 'cancelled' (876) or 'cash_pending' (438), channel 'table', total 0, paid_at
-- NULL, tab_id NULL, session_id '', and no payment reference of any kind.
--
-- They are 37.3% of a financial table, and they have already produced two figures that were
-- acted on. "876 of 891 QR card orders are in a contradictory state" was 876 fixtures and a real
-- population of fifteen. "282 duplicate (firebase_restaurant_id, order_number) pairs" — the
-- number that scoped #127's unique index away from production — was 279 fixture groups out of
-- 283. Both were plausible. Neither was an error anything could have reported.
--
-- ============================================================================================
-- WHY A GENERATED COLUMN AND NOT A BACKFILLED ONE
-- ============================================================================================
--
-- A backfilled boolean is a SECOND source of truth, and this issue is a case study in what those
-- cost: a row inserted tomorrow that matches the pattern would carry `false`, and a row whose
-- restaurant_id is later set would keep `true`, with nothing to notice either. `GENERATED ALWAYS
-- ... STORED` cannot drift, cannot be written by application code, and needs no backfill step
-- that could be half-applied.
--
-- THE `COALESCE` IS THE WHOLE CORRECTNESS ARGUMENT, AND IT IS NOT DECORATION.
--
--   restaurant_id IS NULL AND firebase_restaurant_id LIKE 'restaurant_test_%'
--
-- written like that is THREE-VALUED. For the one production row where BOTH columns are NULL,
-- `NULL LIKE '...'` is NULL, so the whole expression is `TRUE AND NULL` = NULL — not false. The
-- column would then be NULL on exactly the row that most needs a definite answer, and
-- `WHERE NOT is_stress_fixture` would silently drop it, which is the identical mistake the
-- two-clause PostgREST negation makes in `lib/orders/stress-fixtures.ts`. `COALESCE(..., '')`
-- makes the expression total: that row gets FALSE, and it survives every filter written against
-- this column.
--
-- That row is `fa06236b-595f-4492-98d9-05675e6e1c69`, placed 2026-06-16, `order_number` NULL,
-- `status` 'test', total 0. It is not part of the 2026-04-27 seeding run and #324's delete
-- predicate cannot reach it. Whether it should ALSO be marked is a separate ruling; this
-- migration deliberately does not make it, because widening the definition here would silently
-- change what `delete-324-orphan-orders.ts` counts as in scope.
--
-- ============================================================================================
-- WHAT THIS MIGRATION DOES NOT DO
-- ============================================================================================
--
-- IT DOES NOT DELETE ANYTHING. Deletion is the owner's call, and #324's own comment thread is
-- why: several closed findings are evidenced by these rows still being there. The delete script
-- exists (`scripts/prod/delete-324-orphan-orders.ts`, gated behind `--confirm`) and is unrun.
--
-- IT ADDS NO INDEX. 3,522 rows is a sequential scan either way, and the useful predicate
-- (`NOT is_stress_fixture`) selects 63% of the table, which no index would help. An index added
-- "while we are here" is an object nobody can later justify removing.
--
-- IT CHANGES NO APPLICATION CODE. Nothing reads `is_stress_fixture` yet, and nothing should
-- until this has been applied to BOTH environments — a query filtering on a column that does not
-- exist is a 42703 at runtime, not a type error. The sequence, in order:
--
--   1. apply this migration to staging and to production;
--   2. add an `is_stress_fixture` form to `lib/orders/stress-fixtures.ts` beside the three that
--      are already there, so the four cannot drift apart;
--   3. teach `scripts/check-orders-fixture-excluded.ts` to accept `.eq('is_stress_fixture', false)`
--      as a guard;
--   4. only then start using it at call sites.
--
-- REVERSIBLE. `ALTER TABLE public.orders DROP COLUMN IF EXISTS is_stress_fixture;` removes it
-- with no trace, because the column is derived and holds nothing that is not already in the two
-- columns it reads.
--
-- IDEMPOTENT. `ADD COLUMN IF NOT EXISTS` and `COMMENT ON` both re-run safely. No inline CHECK is
-- attached to the ADD COLUMN — per #212 that constraint would be skipped in silence on a re-run
-- where the column already exists, and `scripts/check-migration-inline-check.ts` fails the build
-- for it.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS is_stress_fixture boolean
    GENERATED ALWAYS AS (
      restaurant_id IS NULL
      AND COALESCE(firebase_restaurant_id, '') LIKE 'restaurant_test_%'
    ) STORED;

COMMENT ON COLUMN public.orders.is_stress_fixture IS
  'TRUE for the 2026-04-27 stress-test seeding run (#324): 1,314 rows on production as at '
  '2026-08-27, 37.3% of this table. Derived, never written - GENERATED ALWAYS AS STORED over '
  'restaurant_id and firebase_restaurant_id. ANY CROSS-VENUE COUNT, SUM OR RATIO OVER THIS TABLE '
  'MUST EXCLUDE THESE ROWS or it is wrong by up to 37% with no error: the "876 broken QR orders" '
  'finding and the "282 duplicate order-number pairs" that kept #127''s unique index off '
  'production were both entirely these rows. A read already scoped by restaurant_id, id, tab_id '
  'or table_id cannot reach one and needs nothing. The COALESCE is load-bearing: without it the '
  'expression is NULL rather than FALSE on the one row where restaurant_id AND '
  'firebase_restaurant_id are both NULL (fa06236b-595f-4492-98d9-05675e6e1c69), which is a real '
  'row that must survive every filter. Application code states the same rule in '
  'lib/orders/stress-fixtures.ts and CI enforces it via scripts/check-orders-fixture-excluded.ts.';

-- ============================================================================================
-- VERIFY AFTER APPLYING. Read-only. Expected on production as at 2026-08-27:
--
--     is_stress_fixture | n    | first      | last
--     ------------------+------+------------+------------
--     f                 | 2208 | 2026-06-16 | (today)
--     t                 | 1314 | 2026-04-27 | 2026-06-16
--
-- A NULL bucket means the COALESCE was dropped. A `t` count that is not 1314 means either the
-- delete has been run since (expect 0) or the pattern no longer matches what was seeded.
--
--   SELECT is_stress_fixture, count(*) AS n,
--          min(placed_at)::date AS first, max(placed_at)::date AS last
--   FROM public.orders GROUP BY 1 ORDER BY 1;
--
-- And the row the COALESCE exists for, which must read `f`:
--
--   SELECT id, restaurant_id, firebase_restaurant_id, is_stress_fixture
--   FROM public.orders WHERE id = 'fa06236b-595f-4492-98d9-05675e6e1c69';
-- ============================================================================================
