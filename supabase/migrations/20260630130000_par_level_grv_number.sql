ALTER TABLE "public"."stock_items" ADD COLUMN IF NOT EXISTS "par_level" numeric;

CREATE SEQUENCE IF NOT EXISTS "public"."grv_number_seq" START 1;

ALTER TABLE "public"."goods_received"
  ADD COLUMN IF NOT EXISTS "grv_number" text;

CREATE OR REPLACE FUNCTION "public"."assign_grv_number"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.grv_number IS NULL THEN
        NEW.grv_number := 'GRV-' || LPAD(nextval('grv_number_seq')::text, 6, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assign_grv_number
    BEFORE INSERT ON "public"."goods_received"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."assign_grv_number"();

CREATE UNIQUE INDEX IF NOT EXISTS idx_goods_received_grv_number ON "public"."goods_received"("grv_number");
