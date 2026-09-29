-- @env: both
--
-- ================================================================================================
-- CLOSE THREE SECURITY DEFINER RPCs TO anon / authenticated
-- ================================================================================================
--
-- Found 2026-09-29 by the sprint's staging verification (scripts/staging/verify-sprint-staging.mjs),
-- measured read-only on staging:
--
--   amend_order_lines                 anon EXECUTE = true, authenticated EXECUTE = true
--   settle_order_line_allocations     anon EXECUTE = true, authenticated EXECUTE = true
--   order_is_fully_paid_by_allocations anon EXECUTE = true, authenticated EXECUTE = true
--
-- All three are SECURITY DEFINER with no auth.uid()/permission check inside: they trust their
-- caller, and their only callers are server routes using the service role
-- (app/api/terminal/tabs/[tabId]/amend, .../settle-allocations, lib/payments/settle-allocations-
-- for-intent). With the public anon key a caller could reach them through PostgREST /rpc and void
-- lines on any tab, or settle item allocations as paid with no money taken.
--
-- WHY IT EXISTED. Their migrations (20260829150000, 20260829170000 and every redefinition since,
-- including this sprint's) only `REVOKE ALL ... FROM PUBLIC`. On Supabase the public schema's
-- DEFAULT PRIVILEGES also grant EXECUTE to anon and authenticated DIRECTLY, so revoking PUBLIC
-- leaves those grants in place. The payment-hardening functions (settle_order_payment, 20260919*)
-- revoke anon/authenticated explicitly, which is why they were closed and these were not.
--
-- WHY THE TESTS MISSED IT. The docker fixture had no Supabase default privileges, so the suite's
-- "only service_role can execute" assertions passed against a database that never granted anon
-- anything. supabase/tests/fixture-schema.sql now reproduces the Supabase defaults, so those
-- assertions are measured against the real shape (and failed first, before this migration).
--
-- SAFE TO APPLY BEFORE OR AFTER THE CODE: every caller uses the service role, whose grant is kept
-- and re-asserted. A pure REVOKE of roles nothing legitimate uses; no two-stage deploy needed.
-- ================================================================================================

REVOKE ALL ON FUNCTION public.amend_order_lines(uuid, uuid, integer, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.amend_order_lines(uuid, uuid, integer, text, uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.settle_order_line_allocations(uuid, uuid, uuid[], text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_order_line_allocations(uuid, uuid, uuid[], text, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.order_is_fully_paid_by_allocations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_is_fully_paid_by_allocations(uuid) TO service_role;
