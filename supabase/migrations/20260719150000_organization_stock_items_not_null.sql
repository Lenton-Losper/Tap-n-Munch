-- Workstream 2 (5/5): enforce organization_stock_item_id once the backfill
-- (20260719140000_organization_stock_items_backfill.sql) has been applied and verified
-- for 100% coverage on staging. Deliberately kept as its own migration so a partially
-- applied/failed backfill never leaves stock_items writes broken.
ALTER TABLE "public"."stock_items"
    ALTER COLUMN "organization_stock_item_id" SET NOT NULL;
