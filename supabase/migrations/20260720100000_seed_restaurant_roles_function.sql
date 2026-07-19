-- Business & Locations (1/3): extract restaurant_roles seeding into a standalone function
-- so create_organization_location can reuse the exact logic create_restaurant_for_user
-- already uses, instead of a hand-copied second implementation. Behavior-preserving --
-- identical to the loop this replaces inside create_restaurant_for_user.
CREATE OR REPLACE FUNCTION "public"."seed_restaurant_roles"(p_restaurant_id uuid, p_roles jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role record;
BEGIN
    FOR v_role IN
        SELECT *
        FROM jsonb_to_recordset(p_roles) AS seed(
            role_slug text,
            display_name text,
            permissions jsonb,
            is_system boolean
        )
    LOOP
        INSERT INTO public.restaurant_roles (
            restaurant_id,
            role_slug,
            display_name,
            permissions,
            is_system
        )
        VALUES (
            p_restaurant_id,
            v_role.role_slug,
            v_role.display_name,
            COALESCE(
                ARRAY(SELECT jsonb_array_elements_text(v_role.permissions)),
                ARRAY[]::text[]
            ),
            COALESCE(v_role.is_system, false)
        )
        ON CONFLICT (restaurant_id, role_slug) DO NOTHING;
    END LOOP;
END;
$$;

ALTER FUNCTION "public"."seed_restaurant_roles"(uuid, jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."seed_restaurant_roles"(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."seed_restaurant_roles"(uuid, jsonb) TO service_role;

-- create_restaurant_for_user: replace the inline loop with a call to the extracted
-- function, and add p_organization_name (optional, defaults to the restaurant name --
-- preserves the exact prior behavior for the org name when omitted). This is what lets
-- signup's new "Business name" field be distinct from the first location's name instead
-- of always being forced equal to it.
--
-- Adding a parameter changes the signature, so CREATE OR REPLACE alone would leave the old
-- 6-argument overload dangling as a separate, stale function -- drop it explicitly.
DROP FUNCTION IF EXISTS public.create_restaurant_for_user(uuid, text, text, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.create_restaurant_for_user(
  p_user_id uuid,
  p_email text,
  p_full_name text,
  p_phone text,
  p_restaurant_name text,
  p_roles jsonb,
  p_organization_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id uuid;
  v_organization_id uuid;
BEGIN
  IF p_restaurant_name IS NULL OR btrim(p_restaurant_name) = '' THEN
    RAISE EXCEPTION 'Missing required field: restaurantName';
  END IF;

  IF p_full_name IS NULL OR btrim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Missing required field: fullName';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.restaurant_users ru WHERE ru.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Restaurant already exists for this account';
  END IF;

  INSERT INTO public.users (id, email, full_name, phone)
  VALUES (p_user_id, p_email, p_full_name, p_phone)
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    phone = EXCLUDED.phone;

  INSERT INTO public.organizations (name, owner_user_id)
  VALUES (
    COALESCE(NULLIF(btrim(COALESCE(p_organization_name, '')), ''), btrim(p_restaurant_name)),
    p_user_id
  )
  RETURNING id INTO v_organization_id;

  INSERT INTO public.restaurants (name, phone, currency, organization_id)
  VALUES (btrim(p_restaurant_name), NULLIF(btrim(COALESCE(p_phone, '')), ''), 'NAD', v_organization_id)
  RETURNING id INTO v_restaurant_id;

  INSERT INTO public.organization_users (organization_id, user_id, role)
  VALUES (v_organization_id, p_user_id, 'OWNER');

  PERFORM public.seed_restaurant_roles(v_restaurant_id, p_roles);

  INSERT INTO public.restaurant_users (restaurant_id, user_id, role)
  VALUES (v_restaurant_id, p_user_id, 'owner');

  INSERT INTO public.restaurant_setup_status (
    restaurant_id,
    profile_complete,
    tables_configured,
    menu_added,
    qr_downloaded,
    staff_added,
    terminal_connected,
    test_order_completed,
    first_payment_completed
  )
  VALUES (
    v_restaurant_id,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false
  );

  RETURN v_restaurant_id;
EXCEPTION
  WHEN OTHERS THEN
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.create_restaurant_for_user(uuid, text, text, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_restaurant_for_user(uuid, text, text, text, text, jsonb, text) TO service_role;
