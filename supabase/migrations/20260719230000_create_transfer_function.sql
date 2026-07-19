-- Workstream 4 (3/3): create_transfer, plus tightening dispatch_transfer/receive_transfer's
-- grants now that real permission enforcement exists.
--
-- Security note: dispatch_transfer/receive_transfer/cancel_transfer (Workstream 3) were
-- granted to `authenticated` because WS3 explicitly excluded permissions from its scope.
-- Now that stock:transfer_dispatch/stock:transfer_receive are real, enforced permissions,
-- leaving these callable directly by any authenticated session (bypassing the TypeScript
-- authorize() wrapper entirely) would make that enforcement optional rather than real.
-- Restricting them to service_role matches the existing convention for permission-gated
-- SECURITY DEFINER functions (create_restaurant_for_user is service_role-only; the actual
-- authorize() check happens in application code before the RPC call, not inside SQL).
-- cancel_transfer is deliberately left untouched here -- WS4 does not define a permission
-- model for who may cancel a DRAFT transfer, and inventing one wasn't asked for; flagging
-- that as an open item rather than silently deciding it.
REVOKE EXECUTE ON FUNCTION "public"."dispatch_transfer"(uuid, uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION "public"."receive_transfer"(uuid, uuid, jsonb) FROM authenticated;

-- p_items: jsonb array of {organization_stock_item_id, quantity_sent, unit_id}, same
-- jsonb-array-of-objects convention as receive_transfer's p_received_quantities.
-- Does NOT preflight each item's stock_items mapping at either location -- that's
-- dispatch_transfer's job; a draft is allowed to exist even if configuration isn't
-- finished yet. Permission checks (stock:transfer_create via authorize(), OR
-- authorizeOrganization 'create_cross_location_transfer') happen in the TypeScript
-- caller (lib/stock/transfers.ts) before this function is ever invoked -- this function
-- trusts its caller, same as the other three transfer functions.
CREATE OR REPLACE FUNCTION "public"."create_transfer"(
    p_organization_id uuid,
    p_from_restaurant_id uuid,
    p_to_restaurant_id uuid,
    p_user_id uuid,
    p_items jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_from_org uuid;
    v_to_org uuid;
    v_transfer_id uuid;
    v_item jsonb;
BEGIN
    IF p_from_restaurant_id = p_to_restaurant_id THEN
        RAISE EXCEPTION 'from_restaurant_id and to_restaurant_id must differ';
    END IF;

    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'at least one transfer item is required';
    END IF;

    -- Redundant with the BEFORE INSERT trigger's cross-org check (Workstream 3), but fails
    -- here with a clear application-level message before hitting the trigger's raw
    -- exception.
    SELECT organization_id INTO v_from_org FROM public.restaurants WHERE id = p_from_restaurant_id;
    SELECT organization_id INTO v_to_org FROM public.restaurants WHERE id = p_to_restaurant_id;

    IF v_from_org IS NULL OR v_from_org <> p_organization_id THEN
        RAISE EXCEPTION 'from_restaurant_id % does not belong to organization %', p_from_restaurant_id, p_organization_id;
    END IF;

    IF v_to_org IS NULL OR v_to_org <> p_organization_id THEN
        RAISE EXCEPTION 'to_restaurant_id % does not belong to organization %', p_to_restaurant_id, p_organization_id;
    END IF;

    INSERT INTO public.stock_transfers (organization_id, from_restaurant_id, to_restaurant_id, created_by)
    VALUES (p_organization_id, p_from_restaurant_id, p_to_restaurant_id, p_user_id)
    RETURNING id INTO v_transfer_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        INSERT INTO public.stock_transfer_items (transfer_id, organization_stock_item_id, quantity_sent, unit_id)
        VALUES (
            v_transfer_id,
            (v_item->>'organization_stock_item_id')::uuid,
            (v_item->>'quantity_sent')::numeric,
            (v_item->>'unit_id')::uuid
        );
    END LOOP;

    RETURN v_transfer_id;
END;
$$;

ALTER FUNCTION "public"."create_transfer"(uuid, uuid, uuid, uuid, jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_transfer"(uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."create_transfer"(uuid, uuid, uuid, uuid, jsonb) TO service_role;
