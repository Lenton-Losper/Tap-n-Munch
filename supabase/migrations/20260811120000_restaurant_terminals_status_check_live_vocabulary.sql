-- #193 — restate restaurant_terminals_status_check with the vocabulary the database
-- actually enforces.
--
-- Two migrations declare contradictory closed sets for restaurant_terminals.status:
--
--   00000000000000_baseline.sql            active | inactive | revoked | pending
--   20260620150000_terminal_api_layer.sql  active | revoked | maintenance | pending_update
--
-- The second never took effect. It declares the column with
-- `ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (...)` on a column the
-- baseline had already created, so IF NOT EXISTS short-circuited the whole ADD COLUMN item and
-- took its inline CHECK with it. The constraint on the table is still the baseline's.
--
-- Confirmed empirically on staging on 2026-08-11: status='pending' inserted successfully and
-- status='maintenance' was rejected with SQLSTATE 23514. Production was NOT probed.
--
-- 20260620150000 is left exactly as committed. It is already recorded as applied, rewriting an
-- applied migration is forbidden here, and editing it would additionally change what a fresh
-- or CI database gets. This file is the forward correction instead.
--
-- Its vocabulary is also the wrong one to adopt: 'pending' is absent from it, and all three UI
-- callers of POST /api/admin/terminals/generate-code post an empty body, taking the branch that
-- inserts status='pending' (app/api/admin/terminals/generate-code/route.ts:32). Enforcing
-- 20260620150000's set would break terminal onboarding on the onboarding wizard, the settings
-- payments tab and the terminals section simultaneously.
--
-- 'inactive' is kept. It is live today and it is written:
-- components/settings/settings-payment-tab.tsx:446 updates status='inactive' to deactivate a
-- terminal. Dropping it would reject that write.
--
-- DROP and ADD are two separate statements deliberately. An inline CHECK on
-- ADD COLUMN IF NOT EXISTS is the defect being corrected here, not an idiom to repeat.
--
-- Where the baseline constraint is already in place — staging and, on current evidence,
-- production — this migration changes no enforced behaviour. It exists so the migration history
-- states the enforced vocabulary instead of contradicting it, and so the next reader of
-- 20260620150000 is not misled into typing this column against a set the database rejects.
--
-- Failure mode, if any environment turns out to hold a status outside these four: the ADD
-- CONSTRAINT fails loudly with 23514 naming the offending row. Whether the preceding DROP rolls
-- back with it depends on how the runner wraps the file, so on any failure here, confirm
-- restaurant_terminals_status_check is still present before moving on, and re-run the ADD once
-- the offending rows are corrected.
--
-- The two-statement DROP-then-ADD shape is this repo's established idiom for replacing a CHECK:
-- see 20260628110000_add_cashier_kitchen_roles.sql, 20260629150000_orders_pos_channel.sql and
-- 20260704150000_auth_v2_bar_role.sql.

ALTER TABLE public.restaurant_terminals
  DROP CONSTRAINT IF EXISTS restaurant_terminals_status_check;

ALTER TABLE public.restaurant_terminals
  ADD CONSTRAINT restaurant_terminals_status_check
  CHECK (status IN ('active', 'inactive', 'revoked', 'pending'));
