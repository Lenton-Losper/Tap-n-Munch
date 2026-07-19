-- Business & Locations (2/3): create_organization_location -- the shared function behind
-- both entry points (signup's first location, and Settings' Add Location wizard).
--
-- p_roles is not in the task's illustrative signature, but is required to actually satisfy
-- "reuse the exact seeding logic from create_restaurant_for_user, don't duplicate it by
-- hand": role defaults live in TypeScript (role-permissions.config.json), not in anything
-- SQL can look up on its own, so the caller passes the same jsonb payload
-- buildDefaultRestaurantRolesSeed() already produces for signup, and this function seeds it
-- via the identical seed_restaurant_roles() call create_restaurant_for_user uses.
--
-- Permission checks (authorizeOrganization(..., 'create_location'), OWNER-only) happen in
-- the TypeScript caller (lib/organizations/actions.ts), not here -- this function is
-- SECURITY DEFINER, service_role-only, and trusts its caller, matching every other transfer/
-- restaurant-provisioning function in this codebase (dispatch_transfer, create_transfer,
-- create_restaurant_for_user).
CREATE OR REPLACE FUNCTION "public"."create_organization_location"(
    p_organization_id uuid,
    p_created_by_user_id uuid,
    p_name text,
    p_address text,
    p_roles jsonb,
    p_timezone text DEFAULT NULL,
    p_currency text DEFAULT NULL,
    p_location_type text DEFAULT 'RETAIL',
    p_copy_stock_config_from_restaurant_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_restaurant_id uuid;
    v_reference_restaurant record;
    v_timezone text;
    v_currency text;
    v_source_org_id uuid;
    v_item record;
BEGIN
    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RAISE EXCEPTION 'Missing required field: name';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_organization_id) THEN
        RAISE EXCEPTION 'organization % not found', p_organization_id;
    END IF;

    -- Timezone/currency default from an existing location in the org (any one -- earliest
    -- created, for determinism), falling back to the restaurants table's own column
    -- defaults only if the org somehow has zero restaurants yet. That's not a real path
    -- today (an organization is always created together with its first restaurant), but
    -- this function doesn't hard-assume that invariant holds forever.
    SELECT timezone, currency
    INTO v_reference_restaurant
    FROM public.restaurants
    WHERE organization_id = p_organization_id
    ORDER BY created_at ASC
    LIMIT 1;

    v_timezone := COALESCE(p_timezone, v_reference_restaurant.timezone, 'Africa/Windhoek');
    v_currency := COALESCE(p_currency, v_reference_restaurant.currency, 'NAD');

    -- Validate the copy source belongs to the SAME organization before touching anything --
    -- fail with a clear error here rather than relying solely on the stock_items cross-org
    -- trigger to catch a cross-tenant mistake partway through.
    IF p_copy_stock_config_from_restaurant_id IS NOT NULL THEN
        SELECT organization_id INTO v_source_org_id
        FROM public.restaurants
        WHERE id = p_copy_stock_config_from_restaurant_id;

        IF v_source_org_id IS NULL OR v_source_org_id <> p_organization_id THEN
            RAISE EXCEPTION 'p_copy_stock_config_from_restaurant_id % does not belong to organization %', p_copy_stock_config_from_restaurant_id, p_organization_id;
        END IF;
    END IF;

    INSERT INTO public.restaurants (
        name, address, organization_id, timezone, currency, location_type
    ) VALUES (
        btrim(p_name),
        NULLIF(btrim(COALESCE(p_address, '')), ''),
        p_organization_id,
        v_timezone,
        v_currency,
        p_location_type
    )
    RETURNING id INTO v_restaurant_id;

    PERFORM public.seed_restaurant_roles(v_restaurant_id, p_roles);

    INSERT INTO public.restaurant_users (restaurant_id, user_id, role)
    VALUES (v_restaurant_id, p_created_by_user_id, 'owner');

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
        false, false, false, false, false, false, false, false
    );

    -- Copies configuration only -- never stock_movements or a starting quantity. The new
    -- location's stock always starts at zero regardless of this path; "copy configuration"
    -- and "copy inventory" are deliberately different operations. Does NOT copy recipes or
    -- menu items (materially bigger scope -- recipes tie to menu_items, which would need
    -- their own copy logic -- not built here).
    IF p_copy_stock_config_from_restaurant_id IS NOT NULL THEN
        FOR v_item IN
            SELECT organization_stock_item_id, name, unit_id, is_purchasable, is_manufactured,
                   purchase_unit, conversion_factor, par_level
            FROM public.stock_items
            WHERE restaurant_id = p_copy_stock_config_from_restaurant_id
              AND is_active = true
        LOOP
            INSERT INTO public.stock_items (
                restaurant_id, organization_stock_item_id, name, unit_id, is_purchasable,
                is_manufactured, is_active, purchase_unit, conversion_factor, par_level
            ) VALUES (
                v_restaurant_id, v_item.organization_stock_item_id, v_item.name, v_item.unit_id,
                v_item.is_purchasable, v_item.is_manufactured, true, v_item.purchase_unit,
                v_item.conversion_factor, v_item.par_level
            );
        END LOOP;
    END IF;

    RETURN v_restaurant_id;
EXCEPTION
    WHEN OTHERS THEN
        RAISE;
END;
$$;

ALTER FUNCTION "public"."create_organization_location"(uuid, uuid, text, text, jsonb, text, text, text, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_organization_location"(uuid, uuid, text, text, jsonb, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."create_organization_location"(uuid, uuid, text, text, jsonb, text, text, text, uuid) TO service_role;
