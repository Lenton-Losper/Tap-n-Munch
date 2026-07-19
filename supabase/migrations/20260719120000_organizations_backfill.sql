-- Workstream 2 (2/5): backfill one organization per existing restaurant (1:1).
--
-- No cross-restaurant grouping is invented -- every current client (Riviera, FNB ChowNow,
-- and any others) gets its own organization, keeping the migration uniform across all
-- clients. owner_user_id comes from that restaurant's existing 'owner'-role
-- restaurant_users row (restaurants.owner_id is not reliably populated -- the live signup
-- RPC create_restaurant_for_user never sets it, only restaurant_users does).
--
-- Idempotent: only processes restaurants with organization_id still NULL, so it is safe to
-- re-run after a partial failure.
DO $$
DECLARE
    v_restaurant record;
    v_owner_user_id uuid;
    v_org_id uuid;
BEGIN
    FOR v_restaurant IN
        SELECT id, name, created_at, deleted_at
        FROM public.restaurants
        WHERE organization_id IS NULL
        ORDER BY created_at
    LOOP
        SELECT ru.user_id
        INTO v_owner_user_id
        FROM public.restaurant_users ru
        WHERE ru.restaurant_id = v_restaurant.id
          AND ru.role = 'owner'
          AND ru.deleted_at IS NULL
        ORDER BY ru.created_at ASC
        LIMIT 1;

        IF v_owner_user_id IS NULL THEN
            -- A restaurant with zero live members at all (soft-deleted, or an orphaned
            -- fixture nobody can ever log into -- e.g. an old verify script that failed
            -- cleanup) isn't a real tenant; skip it rather than block the whole backfill on
            -- dead data. A restaurant that DOES have live members but none with role
            -- 'owner' is a genuine integrity problem worth stopping for.
            IF NOT EXISTS (
                SELECT 1 FROM public.restaurant_users ru
                WHERE ru.restaurant_id = v_restaurant.id AND ru.deleted_at IS NULL
            ) THEN
                RAISE NOTICE 'skipping restaurant % (%) with zero live restaurant_users rows', v_restaurant.id, v_restaurant.name;
                CONTINUE;
            END IF;
            RAISE EXCEPTION 'restaurant % (%) has live members but no owner restaurant_users row; cannot backfill organization', v_restaurant.id, v_restaurant.name;
        END IF;

        INSERT INTO public.organizations (name, owner_user_id, created_at)
        VALUES (v_restaurant.name, v_owner_user_id, v_restaurant.created_at)
        RETURNING id INTO v_org_id;

        UPDATE public.restaurants SET organization_id = v_org_id WHERE id = v_restaurant.id;

        INSERT INTO public.organization_users (organization_id, user_id, role, created_at)
        VALUES (v_org_id, v_owner_user_id, 'OWNER', v_restaurant.created_at)
        ON CONFLICT (organization_id, user_id) DO NOTHING;
    END LOOP;
END $$;
