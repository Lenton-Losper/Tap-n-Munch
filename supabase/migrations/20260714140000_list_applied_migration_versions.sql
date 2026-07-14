-- Exposes applied migration versions for CI drift-checking (#38/#20).
-- supabase_migrations.schema_migrations isn't reachable via PostgREST by
-- default (not in the exposed public schema), so CI needs a narrow,
-- read-only, service_role-only RPC instead of direct DB/CLI credentials.

CREATE OR REPLACE FUNCTION public.list_applied_migration_versions()
RETURNS TABLE (version text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, supabase_migrations
AS $$
  SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;
$$;

REVOKE ALL ON FUNCTION public.list_applied_migration_versions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_applied_migration_versions() TO service_role;
