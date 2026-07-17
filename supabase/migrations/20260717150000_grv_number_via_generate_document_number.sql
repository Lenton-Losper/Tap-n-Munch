-- goods_received numbering cleanup: assign_grv_number() duplicated the exact prefix +
-- LPAD(nextval(...), 6, '0') logic that generate_document_number(prefix, sequence_name)
-- (introduced in the receipt capability Phase 1 migration) already provides generically.
-- Delegate to it instead of reimplementing it, so there's one numbering mechanism, not two.
--
-- No app-code change: goods_received inserts never set grv_number themselves (see
-- lib/stock/actions.ts) -- the BEFORE INSERT trigger still fills it in, it just now
-- delegates the actual number generation. grv_number_seq is untouched and keeps
-- counting from its current value -- this is a formatting-logic change, not a reset.

CREATE OR REPLACE FUNCTION "public"."assign_grv_number"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.grv_number IS NULL THEN
        NEW.grv_number := public.generate_document_number('GRV', 'grv_number_seq');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
