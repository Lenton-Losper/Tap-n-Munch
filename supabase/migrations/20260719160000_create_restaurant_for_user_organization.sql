-- Workstream 2 follow-up: without this, every restaurant created after the organizations
-- migration lands would be provisioned with organization_id NULL and no organization_users
-- row, silently reopening the exact gap this workstream exists to close. Extends the
-- existing atomic signup RPC (20260709180000_create_restaurant_for_user.sql) with an
-- organization + OWNER membership insert, same 1:1-per-restaurant shape as the backfill.

CREATE OR REPLACE FUNCTION public.create_restaurant_for_user(
  p_user_id uuid,
  p_email text,
  p_full_name text,
  p_phone text,
  p_restaurant_name text,
  p_roles jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restaurant_id uuid;
  v_organization_id uuid;
  v_role record;
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
  VALUES (btrim(p_restaurant_name), p_user_id)
  RETURNING id INTO v_organization_id;

  INSERT INTO public.restaurants (name, phone, currency, organization_id)
  VALUES (btrim(p_restaurant_name), NULLIF(btrim(COALESCE(p_phone, '')), ''), 'NAD', v_organization_id)
  RETURNING id INTO v_restaurant_id;

  INSERT INTO public.organization_users (organization_id, user_id, role)
  VALUES (v_organization_id, p_user_id, 'OWNER');

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
      v_restaurant_id,
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

REVOKE ALL ON FUNCTION public.create_restaurant_for_user(uuid, text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_restaurant_for_user(uuid, text, text, text, text, jsonb) TO service_role;
