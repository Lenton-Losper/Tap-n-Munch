-- View-only ordering points: a QR/link that renders the menu but can never start a tab
-- or place an order (e.g. a canteen entrance/noticeboard menu, distinct from any specific
-- dining table). Modeled the same way as is_kiosk -- a boolean on restaurant_tables, not a
-- new table -- so it reuses the existing ordering-point CRUD (app/api/admin/tables), the
-- existing QR management UI, and the existing table_number-based lookups everywhere else.
ALTER TABLE "public"."restaurant_tables"
  ADD COLUMN IF NOT EXISTS "is_view_only" boolean NOT NULL DEFAULT false;

-- A point is never both a kiosk and view-only -- they're separate ordering-point kinds.
ALTER TABLE "public"."restaurant_tables"
  ADD CONSTRAINT "restaurant_tables_view_only_not_kiosk"
  CHECK (NOT ("is_view_only" AND "is_kiosk"));
