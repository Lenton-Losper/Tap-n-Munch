-- Persist menu item fields previously collected in UI but dropped by API.
ALTER TABLE "public"."menu_items"
  ADD COLUMN IF NOT EXISTS "image_fit" text NOT NULL DEFAULT 'contain',
  ADD COLUMN IF NOT EXISTS "image_position" text NOT NULL DEFAULT 'center',
  ADD COLUMN IF NOT EXISTS "allow_special_instructions" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "has_sizes" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sizes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "has_addons" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "addons" jsonb NOT NULL DEFAULT '[]'::jsonb;
