-- Restore Receive Stock: assign_grv_number() must run as its owner, not as the caller.
--
-- Three individually-correct changes combined into a total outage of the Receive Stock
-- screen:
--
--   20260717150000 made assign_grv_number() (a BEFORE INSERT trigger on goods_received)
--     delegate to public.generate_document_number('GRV','grv_number_seq'). The trigger was
--     not SECURITY DEFINER, so it executes with the privileges of whoever runs the INSERT.
--   20260727140000 / 20260727150000 revoked EXECUTE on generate_document_number(text,text)
--     from PUBLIC/anon/authenticated, granting it to service_role only.
--   lib/stock/actions.ts saveGrvAction inserts goods_received on the request-scoped client,
--     i.e. as role `authenticated`.
--
-- Result: every staff delivery submission raised
--   42501 permission denied for function generate_document_number
-- and the raw Postgres string was rendered to the merchant. No goods_received row, no
-- stock_movements row, no stock increase. saveGrvAction is the only writer to
-- goods_received anywhere in the codebase, so there was no unaffected path.
--
-- SECURITY DEFINER is the correct fix rather than re-granting EXECUTE to `authenticated`:
-- the 27 July migrations deliberately closed direct access to the numbering function, and
-- re-opening it would hand every authenticated role the ability to burn sequence values on
-- any document type. Making the trigger run as owner keeps that closed while letting the
-- INSERT that already passed RLS obtain its number.
--
-- This does not widen who may insert a GRV. Inserting into goods_received is still governed
-- by that table's own grants and RLS; this only lets the number be generated once the insert
-- is already permitted. search_path is pinned so the definer context cannot be redirected.

CREATE OR REPLACE FUNCTION "public"."assign_grv_number"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.grv_number IS NULL THEN
        NEW.grv_number := public.generate_document_number('GRV', 'grv_number_seq');
    END IF;
    RETURN NEW;
END;
$$;

-- A trigger function is invoked by the trigger, never called directly, so no role needs
-- EXECUTE on it. Keep it that way -- with SECURITY DEFINER, a direct grant would let a
-- caller run owner-privileged code at will.
REVOKE ALL ON FUNCTION "public"."assign_grv_number"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."assign_grv_number"() FROM anon, authenticated;
