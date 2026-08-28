-- ADR-005 -- which stations a menu item routes to. Many-to-many, because a drink can be at both
-- bars and a sharing platter is made in two places.
--
-- NOT APPLIED BY THE AUTHORING AGENT AT AUTHORING TIME.
--
-- ============================================================================================
-- ABSENCE IS MEANINGFUL, AND IT IS WHAT KEEPS EVERY EXISTING VENUE WORKING
-- ============================================================================================
--
-- A menu item with NO rows here is not misconfigured. It falls back to its category's
-- `menu_categories.route_to`, mapped onto the restaurant's seeded 'kitchen' / 'bar' stations.
--
-- That fallback is the entire reason this migration is additive. Riviera has 198 items and
-- ChowNow and Mingle have their own; none of them need a single row inserted for service to carry
-- on exactly as it does today. Riviera then inserts rows only for the drinks that belong to a
-- specific bar, which is a handful of categories rather than 198 items.
--
-- So the routing resolution order is, and must stay:
--   1. explicit rows here                  -> those stations
--   2. else the category's route_to        -> the seeded station of that kind
--   3. else / unrecognised                 -> ALL active stations, so the line is visible
--                                             everywhere rather than silently nowhere
--
-- Step 3 is the 'unrouted' rule generalised: a line nobody can route must appear on every board
-- and be flagged, because food that shows on no screen is food that never gets made.
--
-- ============================================================================================
-- restaurant_id IS DENORMALISED HERE ON PURPOSE
-- ============================================================================================
--
-- It is derivable from either side, and it is stored anyway so RLS can scope this table with a
-- plain column check instead of a two-table join on every read. The CHECK below makes the
-- denormalisation honest: a row cannot name a menu item and a station from different restaurants,
-- which is the cross-tenant shape this project has been bitten by before (#122).

CREATE TABLE IF NOT EXISTS public.menu_item_stations (
  menu_item_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
  station_id uuid NOT NULL REFERENCES public.restaurant_stations(id) ON DELETE CASCADE,

  -- Scoping copy. Kept true by the trigger below, never by the caller.
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (menu_item_id, station_id)
);

COMMENT ON TABLE public.menu_item_stations IS
  'ADR-005: which stations a menu item routes to. NO ROWS MEANS FALL BACK to the category route_to mapped onto the seeded kitchen/bar stations -- that fallback is why this is additive and why no existing venue needs configuring.';

-- ---------------------------------------------------------------------------
-- The tenant guard. A menu item and a station from two different restaurants must never be
-- paired -- that is the #122 cross-tenant shape, and here it would route one venue's food to
-- another venue's board.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.menu_item_stations_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  item_restaurant uuid;
  station_restaurant uuid;
BEGIN
  SELECT restaurant_id INTO item_restaurant FROM public.menu_items WHERE id = NEW.menu_item_id;
  SELECT restaurant_id INTO station_restaurant FROM public.restaurant_stations WHERE id = NEW.station_id;

  IF item_restaurant IS NULL OR station_restaurant IS NULL THEN
    RAISE EXCEPTION 'menu_item_stations: unknown menu item or station';
  END IF;

  IF item_restaurant <> station_restaurant THEN
    RAISE EXCEPTION
      'menu_item_stations: menu item belongs to % but station belongs to % -- cross-tenant routing refused',
      item_restaurant, station_restaurant;
  END IF;

  -- Derived, never trusted from the caller.
  NEW.restaurant_id := item_restaurant;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS menu_item_stations_guard_trigger ON public.menu_item_stations;
CREATE TRIGGER menu_item_stations_guard_trigger
  BEFORE INSERT OR UPDATE ON public.menu_item_stations
  FOR EACH ROW EXECUTE FUNCTION public.menu_item_stations_guard();

-- "Which items route to this station" -- the menu-audit read, and the report Riviera verifies
-- their menu against.
CREATE INDEX IF NOT EXISTS menu_item_stations_station_idx
  ON public.menu_item_stations (station_id);

CREATE INDEX IF NOT EXISTS menu_item_stations_restaurant_idx
  ON public.menu_item_stations (restaurant_id);

ALTER TABLE public.menu_item_stations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized staff can read menu item stations" ON public.menu_item_stations;
CREATE POLICY "Authorized staff can read menu item stations"
  ON public.menu_item_stations
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'menu:read'));
