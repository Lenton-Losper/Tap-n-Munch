-- Sweep of every SECURITY DEFINER function in public following the same
-- default-privilege grant gap found and fixed on record_terminal_refund_event
-- (20260727130000): this project auto-grants EXECUTE on newly created public
-- functions to anon/authenticated at CREATE time, so "REVOKE ALL FROM PUBLIC"
-- (which only revokes what was granted to the PUBLIC pseudo-role) silently
-- leaves those two roles with EXECUTE regardless of the migration's intent.
--
-- Every function below was confirmed exploitable on staging: an anon-key
-- client (no session, no server-side permission check) called it directly
-- via PostgREST and either mutated real data cross-tenant or leaked
-- information the app never intended to expose to an unauthenticated caller.
--   - create_restaurant_for_user: anon created a real restaurant/org/owner
--     membership for an arbitrary fabricated user_id.
--   - cancel_transfer: anon cancelled a real cross-tenant stock transfer.
--   - list_applied_migration_versions / list_tenant_isolation_rls_status /
--     is_platform_admin / should_show_google_signin_hint: anon read data
--     meant to be service-role/authenticated-only.
-- dispatch_transfer / receive_transfer / create_transfer /
-- create_organization_location / seed_restaurant_roles share the identical
-- pattern (blind trust of a caller-supplied p_user_id / p_restaurant_id with
-- no internal auth.uid() check) and are fixed on the same evidence rather
-- than re-proving each individually.
--
-- correct_invoice / generate_document_number / get_next_document_number /
-- set_document_sequence_start were granted to `authenticated` by their
-- original migrations, but every real caller in the app (grep-verified)
-- invokes them via createServerSupabaseClient() (service_role), doing its
-- own permission check first -- no legitimate direct-authenticated-client
-- call path exists, so authenticated is revoked here too, not just anon.
--
-- NOT touched: user_has_permission / user_restaurant_ids /
-- user_organization_ids / user_owner_organization_ids -- these are embedded
-- directly in RLS policies for `authenticated` (and in some cases `anon`)
-- and internally scope everything to auth.uid(), so revoking would break
-- RLS enforcement rather than fix anything. notify_kitchen_on_new_order is
-- a trigger function (RETURNS trigger) -- not directly callable outside a
-- trigger context regardless of grants.

REVOKE EXECUTE ON FUNCTION public.create_restaurant_for_user(
  uuid, text, text, text, text, jsonb, text
) FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.should_show_google_signin_hint(text)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.list_applied_migration_versions()
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.list_tenant_isolation_rls_status()
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.create_transfer(
  uuid, uuid, uuid, uuid, jsonb
) FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.seed_restaurant_roles(uuid, jsonb)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.create_organization_location(
  uuid, uuid, text, text, jsonb, text, text, text, uuid
) FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.dispatch_transfer(uuid, uuid)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.receive_transfer(uuid, uuid, jsonb)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.cancel_transfer(uuid, uuid)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.correct_invoice(uuid, jsonb, text, uuid)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.generate_document_number(text, text)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.get_next_document_number(uuid, text)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.set_document_sequence_start(uuid, text, integer)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.is_platform_admin(uuid)
  FROM anon, authenticated;
