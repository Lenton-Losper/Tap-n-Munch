-- Workstream 2 (1/5): organizations + explicit membership.
-- Additive only: restaurants keeps its own RLS/policies unchanged; this only adds
-- an organization_id FK column (nullable for now) plus a location_type classifier.

CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" text NOT NULL,
    "legal_name" text,
    "owner_user_id" uuid NOT NULL REFERENCES "public"."users"("id"),
    "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "public"."restaurants"
    ADD COLUMN IF NOT EXISTS "organization_id" uuid REFERENCES "public"."organizations"("id"),
    ADD COLUMN IF NOT EXISTS "location_type" text NOT NULL DEFAULT 'RETAIL'
        CHECK ("location_type" IN ('RETAIL', 'COMMISSARY', 'CENTRAL_KITCHEN', 'KIOSK', 'WAREHOUSE'));

CREATE INDEX IF NOT EXISTS idx_restaurants_organization ON "public"."restaurants"("organization_id");

-- Role semantics: only OWNER carries organization-wide visibility/cross-location access
-- in v1. MEMBER is a placeholder for a future non-owner org-level role and grants nothing
-- extra yet -- a member's real access is still whatever they hold via restaurant_users at
-- specific locations, unchanged.
CREATE TABLE IF NOT EXISTS "public"."organization_users" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id" uuid NOT NULL REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
    "user_id" uuid NOT NULL REFERENCES "public"."users"("id"),
    "role" text NOT NULL DEFAULT 'MEMBER' CHECK ("role" IN ('OWNER', 'MEMBER')),
    "created_at" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organization_id", "user_id")
);

CREATE INDEX IF NOT EXISTS idx_organization_users_user ON "public"."organization_users"("user_id");

-- SECURITY DEFINER lookups, same pattern as user_restaurant_ids() (see
-- 20260630140000_fix_restaurant_users_rls_recursion.sql): the function is owned by the
-- table owner, so it bypasses RLS on organization_users internally and can safely be used
-- inside organization_users' own policies without recursing.
CREATE OR REPLACE FUNCTION "public"."user_organization_ids"()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT organization_id FROM organization_users WHERE user_id = auth.uid();
$$;

ALTER FUNCTION "public"."user_organization_ids"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."user_owner_organization_ids"()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT organization_id FROM organization_users WHERE user_id = auth.uid() AND role = 'OWNER';
$$;

ALTER FUNCTION "public"."user_owner_organization_ids"() OWNER TO "postgres";

ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."organization_users" ENABLE ROW LEVEL SECURITY;

-- Writes to organizations/organization_users happen through SECURITY DEFINER functions
-- (create_restaurant_for_user) or service-role backfill, matching restaurants (which has
-- no authenticated write policy either) -- so only SELECT policies are needed here.
CREATE POLICY "Members can read own organization"
    ON "public"."organizations"
    FOR SELECT
    USING ("id" IN (SELECT "public"."user_organization_ids"()));

CREATE POLICY "Users can read own organization_users row"
    ON "public"."organization_users"
    FOR SELECT
    USING (auth.uid() = "user_id");

CREATE POLICY "Users can read members of their organization"
    ON "public"."organization_users"
    FOR SELECT
    USING ("organization_id" IN (SELECT "public"."user_organization_ids"()));
