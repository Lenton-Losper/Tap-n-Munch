-- Persist whether a menu item should deduct stock on sale (inventory tracking intent).
ALTER TABLE "public"."menu_items"
  ADD COLUMN IF NOT EXISTS "track_inventory" boolean NOT NULL DEFAULT false;

-- Items that already have an active recipe were tracking inventory before this column existed.
UPDATE "public"."menu_items" mi
SET track_inventory = true
WHERE track_inventory = false
  AND EXISTS (
    SELECT 1
    FROM "public"."recipes" r
    WHERE r.menu_item_id = mi.id
      AND r.is_active = true
  );
