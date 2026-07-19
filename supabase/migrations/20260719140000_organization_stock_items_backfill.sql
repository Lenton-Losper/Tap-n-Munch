-- Workstream 2 (4/5): backfill one organization_stock_items row per existing stock_items
-- row, strictly 1:1 -- no name-based deduplication across locations. Safe today because
-- every existing client is effectively single-location; do not generalize this to any
-- future real multi-location onboarding (that dedup problem belongs to a real onboarding
-- flow, not a mechanical backfill).
--
-- A DO-block loop (rather than an INSERT ... SELECT + correlated UPDATE) is used
-- deliberately: two stock_items rows in the same restaurant could share the same
-- (name, unit) natural key, which would make a set-based correlation ambiguous. The loop
-- guarantees each stock_items row gets its own newly-created organization_stock_items row.
--
-- Idempotent: only processes stock_items rows with organization_stock_item_id still NULL.
DO $$
DECLARE
    v_stock_item record;
    v_new_id uuid;
BEGIN
    FOR v_stock_item IN
        SELECT si.id, si.name, si.unit_id, si.is_manufactured, si.created_at, r.organization_id
        FROM public.stock_items si
        JOIN public.restaurants r ON r.id = si.restaurant_id
        WHERE si.organization_stock_item_id IS NULL
        ORDER BY si.created_at
    LOOP
        IF v_stock_item.organization_id IS NULL THEN
            RAISE EXCEPTION 'restaurant for stock_item % has no organization_id; run 20260719120000_organizations_backfill.sql first', v_stock_item.id;
        END IF;

        INSERT INTO public.organization_stock_items (organization_id, name, base_unit_id, is_manufactured, created_at)
        VALUES (v_stock_item.organization_id, v_stock_item.name, v_stock_item.unit_id, v_stock_item.is_manufactured, v_stock_item.created_at)
        RETURNING id INTO v_new_id;

        UPDATE public.stock_items SET organization_stock_item_id = v_new_id WHERE id = v_stock_item.id;
    END LOOP;
END $$;
