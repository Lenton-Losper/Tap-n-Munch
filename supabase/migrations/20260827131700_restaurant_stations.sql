-- ADR-005 -- stations become per-restaurant DATA instead of a three-value enum.
--
-- NOT APPLIED BY THE AUTHORING AGENT AT AUTHORING TIME.
--
-- ============================================================================================
-- WHY THE ENUM CANNOT SURVIVE
-- ============================================================================================
--
-- Riviera has TWO BARS, upstairs and downstairs, stocking DIFFERENT items. A drink routes to the
-- bar that carries it. That is a property of the MENU ITEM, and `route_to IN ('kitchen','bar',
-- 'both')` cannot express it at all -- there is no vocabulary for "the upstairs one".
--
-- Another venue has one bar. A third might have a grill and a cold section, or a coffee bar. The
-- set of stations is a fact about a restaurant, so it belongs in rows a venue can add to, not in
-- a CHECK constraint that needs a migration and a deploy to change.
--
-- ADDING A STATION MUST BE AN INSERT. That is the whole point of this table.
--
-- ============================================================================================
-- THE SEED IS THE GUARANTEE FOR CHOWNOW AND MINGLE
-- ============================================================================================
--
-- Every existing restaurant is seeded with exactly two stations, 'kitchen' and 'bar', which is
-- precisely what the old enum gave them. Their categories keep saying kitchen/bar, those map 1:1
-- onto the seeded rows, and nothing about their service changes. They trade tomorrow morning on
-- the existing flow and this migration is invisible to them.
--
-- Riviera then adds a third row and re-points its drinks. No code, no deploy.
--
-- ============================================================================================
-- `kind` IS FOR ICONS AND FOR THE SEED. ROUTING NEVER READS IT.
-- ============================================================================================
--
-- It exists so a screen can show a hob or a glass without parsing a name, and so the backfill in
-- 20260827131900 can map the old enum onto the seeded rows. If routing ever branches on `kind`,
-- the enum has been reinvented one column to the left -- which is the mistake this table exists
-- to undo.
--
-- `key` is the stable slug used by URLs and by the seed. `name` is what the venue calls it and is
-- the only thing a human should ever see: "what the two bars are actually called" is answered by
-- an UPDATE, not by a release.

CREATE TABLE IF NOT EXISTS public.restaurant_stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

  -- Stable slug: 'kitchen', 'bar', 'bar-upstairs'. Never shown to a human.
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,48}$'),

  -- What the venue calls it. The answer to "what are the two bars called" lives here.
  name text NOT NULL,

  -- Coarse family, for iconography and for the enum backfill. NOT a routing input.
  kind text NOT NULL CHECK (kind IN ('kitchen', 'bar')),

  display_order integer NOT NULL DEFAULT 0,

  -- A decommissioned station keeps its rows so history still reads, but stops taking new lines.
  active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT restaurant_stations_key_unique UNIQUE (restaurant_id, key)
);

COMMENT ON TABLE public.restaurant_stations IS
  'ADR-005: the stations a restaurant routes lines to. Per-restaurant and configurable because Riviera has two bars stocking different items, which route_to IN (kitchen,bar,both) cannot express. Adding a station is an INSERT, never a migration.';

COMMENT ON COLUMN public.restaurant_stations.kind IS
  'Coarse family (kitchen|bar) for icons and for the 20260827131900 backfill. ROUTING MUST NEVER READ THIS -- branching on it recreates the enum this table exists to remove.';

COMMENT ON COLUMN public.restaurant_stations.name IS
  'The venue''s own name for the station, and the only field a human sees. Renaming a bar is an UPDATE, not a release.';

-- The screen pairing read: "which stations does this venue have".
CREATE INDEX IF NOT EXISTS restaurant_stations_restaurant_idx
  ON public.restaurant_stations (restaurant_id, display_order)
  WHERE active;

-- ---------------------------------------------------------------------------
-- SEED: two stations per existing restaurant, matching the enum they have today.
-- ---------------------------------------------------------------------------
--
-- ON CONFLICT DO NOTHING so this is safe to re-run, and safe on an environment where a human has
-- already inserted a station by hand -- which is exactly how staging and production drift here.
INSERT INTO public.restaurant_stations (restaurant_id, key, name, kind, display_order)
SELECT r.id, 'kitchen', 'Kitchen', 'kitchen', 0 FROM public.restaurants r
ON CONFLICT (restaurant_id, key) DO NOTHING;

INSERT INTO public.restaurant_stations (restaurant_id, key, name, kind, display_order)
SELECT r.id, 'bar', 'Bar', 'bar', 1 FROM public.restaurants r
ON CONFLICT (restaurant_id, key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS: staff with orders:read may read. Writes are service role (no admin UI tonight --
-- a venue's stations are inserted directly, which is why this table is small and boring).
-- ---------------------------------------------------------------------------
ALTER TABLE public.restaurant_stations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized staff can read stations" ON public.restaurant_stations;
CREATE POLICY "Authorized staff can read stations"
  ON public.restaurant_stations
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'orders:read'));
