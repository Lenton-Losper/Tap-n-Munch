-- record_terminal_refund_event (20260727120000) intended service_role-only
-- execution via REVOKE ALL ... FROM PUBLIC + GRANT EXECUTE ... TO service_role.
-- That does not touch grants already held directly by anon/authenticated
-- (this project's default privileges grant EXECUTE on new public functions
-- to anon/authenticated at CREATE time), so both roles retained EXECUTE.
-- Confirmed exploitable on staging: an anon-key client called the RPC
-- directly via PostgREST and inserted a real refund_succeeded payment_event
-- row, bypassing terminal JWT auth and PIN-authorization-token consumption
-- entirely. Explicit revoke closes it.

REVOKE EXECUTE ON FUNCTION public.record_terminal_refund_event(
  uuid, uuid[], text, text, text, text, text, numeric, text, text, uuid, text, text, text, text
) FROM anon, authenticated;
