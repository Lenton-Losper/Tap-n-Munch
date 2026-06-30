ALTER TABLE "public"."stock_movements"
    ADD COLUMN IF NOT EXISTS "adjustment_type" text;

ALTER TABLE "public"."stock_movements"
    ADD CONSTRAINT "valid_adjustment_type" CHECK (
        adjustment_type IS NULL
        OR adjustment_type IN ('sale', 'waste', 'damage', 'count', 'other')
    );

ALTER TABLE "public"."stock_movements"
    ADD CONSTRAINT "adjustment_type_requires_adjustment_reason" CHECK (
        (adjustment_type IS NULL) OR (reason = 'adjustment')
    );
