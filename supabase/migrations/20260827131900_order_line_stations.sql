-- ADR-005 -- per-station line state as ROWS, replacing kitchen_state / bar_state.
--
-- NOT APPLIED BY THE AUTHORING AGENT AT AUTHORING TIME.
--
-- ============================================================================================
-- WHY COLUMNS HAD TO BECOME ROWS
-- ============================================================================================
--
-- `kitchen_state` and `bar_state` are two columns, which is structurally two stations forever.
-- Riviera has three. A fourth venue might have five. N stations must be N rows.
--
-- Everything else about the model is unchanged and was proven on staging tonight: one line per
-- ordered item, independent state per station, so the kitchen marking its half done does not
-- clear the bar's half, while a cancellation still cancels ONE thing and the bill counts the item
-- ONCE.
--
-- ============================================================================================
-- FOUR STATES, TWO ACTORS
-- ============================================================================================
--
--   outstanding  -> nobody has started it
--   cooked       -> the STATION has made it. Durable, and it has to be: a cook who plated a dish
--                   two minutes ago and a cook who has not started must not look identical on the
--                   board. That visibility is the entire reason the pass exists.
--   ready        -> the PASS has passed it. This is what a waiter walks in to read.
--   voided       -> cancelled or amended away at the terminal.
--
-- Two actors, and they are distinct on purpose: a station may write `cooked`, the pass writes
-- `ready`. A station cannot mark its own dish ready to run.
--
-- `cooked` is not a state nothing exits from -- it has a defined exit and a person standing at it.
--
-- ============================================================================================
-- NO PARTIAL INDEX ON A STATE VALUE. THIS IS THE SHARPEST LESSON OF THE NIGHT.
-- ============================================================================================
--
-- 20260827131000 indexed the screens with `WHERE kitchen_state = 'outstanding'`. That is a
-- HARDCODED STATE COMPARISON IN DDL. It survives any code audit -- nothing in TypeScript mentions
-- it -- and the moment a line can sit in a state that is neither 'outstanding' nor finished, it
-- falls out of the index and the screen query silently stops returning it. No error. No slow
-- query. A plate that simply is not on the board.
--
-- Adding `cooked` is exactly that change. So the index below carries NO state predicate: it
-- includes `state` as a column instead. Marginally larger, and it cannot rot when the vocabulary
-- grows again.
--
-- RULE, for anything built on this: A WHERE CLAUSE ON A STATE VALUE IS A HARDCODED COMPARISON AND
-- MUST BE RE-DERIVED WHENEVER THE ENUM CHANGES. Prefer indexing the column.
--
-- ============================================================================================
-- SNAPSHOTS, BECAUSE A LINE RECORDS WHAT WAS TRUE WHEN IT WAS CREATED
-- ============================================================================================
--
-- `station_key_snapshot` and `station_name_snapshot` freeze the station on the line. Renaming
-- "Bar" to "Bar (Upstairs)" at 8pm must not rewrite what a drink already being poured was routed
-- to -- the same rule as `name_snapshot` and frozen routing, and the same rule the immutable
-- receipt snapshot follows.
--
-- station_id is ON DELETE RESTRICT rather than SET NULL: a station with history cannot be
-- deleted, only deactivated (`restaurant_stations.active = false`). SET NULL would break the
-- uniqueness below and quietly orphan the history.

CREATE TABLE IF NOT EXISTS public.order_line_stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

  order_line_id uuid NOT NULL REFERENCES public.order_lines(id) ON DELETE CASCADE,

  station_id uuid NOT NULL REFERENCES public.restaurant_stations(id) ON DELETE RESTRICT,

  -- Frozen at creation. See the header.
  station_key_snapshot text NOT NULL,
  station_name_snapshot text NOT NULL,

  state text NOT NULL DEFAULT 'outstanding'
    CHECK (state IN ('outstanding', 'cooked', 'ready', 'voided')),

  created_at timestamptz NOT NULL DEFAULT now(),

  -- One row per station per line. This is what makes "independent state per station" a fact
  -- rather than a convention.
  CONSTRAINT order_line_stations_unique UNIQUE (order_line_id, station_id)
);

COMMENT ON TABLE public.order_line_stations IS
  'ADR-005: per-station state for a fulfilment line, as rows. Replaces kitchen_state/bar_state, which were two columns and therefore two stations forever. States: outstanding -> cooked (the station) -> ready (the pass), plus voided.';

COMMENT ON COLUMN public.order_line_stations.state IS
  'outstanding | cooked | ready | voided. The STATION writes cooked; the PASS writes ready. A station cannot mark its own dish ready to run. NEVER index this with a WHERE predicate on a specific value -- see the header.';

COMMENT ON COLUMN public.order_line_stations.station_key_snapshot IS
  'Frozen at creation. Renaming a bar at 8pm must not rewrite what a drink already being poured was routed to.';

-- ---------------------------------------------------------------------------
-- Indexes. NOTE THE ABSENCE OF ANY STATE PREDICATE -- see the header.
-- ---------------------------------------------------------------------------

-- THE STATION SCREEN QUERY: this station's lines, any state, oldest first. The screen filters
-- states itself, so a new state can never fall out of the index.
CREATE INDEX IF NOT EXISTS order_line_stations_station_idx
  ON public.order_line_stations (restaurant_id, station_id, state, created_at);

-- "This line's stations" -- the table view, and the readiness computation.
CREATE INDEX IF NOT EXISTS order_line_stations_line_idx
  ON public.order_line_stations (order_line_id);

-- ---------------------------------------------------------------------------
-- BACKFILL from the two columns being retired.
-- ---------------------------------------------------------------------------
--
-- 'done' meant "this station has finished with it", which under the four-state vocabulary is
-- READY -- the old model had no pass, so finished and ready-to-run were the same event.
-- Mapping it to 'cooked' would invent a pass step nobody performed and hold plates that were
-- already run.
--
-- Scoped to lines whose restaurant actually has the seeded station, so a venue seeded oddly is
-- skipped rather than failing the migration.
INSERT INTO public.order_line_stations
  (restaurant_id, order_line_id, station_id, station_key_snapshot, station_name_snapshot, state, created_at)
SELECT
  l.restaurant_id,
  l.id,
  s.id,
  s.key,
  s.name,
  CASE col.old_state WHEN 'done' THEN 'ready' WHEN 'voided' THEN 'voided' ELSE 'outstanding' END,
  l.created_at
FROM public.order_lines l
CROSS JOIN LATERAL (
  VALUES ('kitchen', l.kitchen_state), ('bar', l.bar_state)
) AS col(station_key, old_state)
JOIN public.restaurant_stations s
  ON s.restaurant_id = l.restaurant_id AND s.key = col.station_key
WHERE col.old_state IS NOT NULL
ON CONFLICT (order_line_id, station_id) DO NOTHING;

ALTER TABLE public.order_line_stations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized staff can read order line stations" ON public.order_line_stations;
CREATE POLICY "Authorized staff can read order line stations"
  ON public.order_line_stations
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'orders:read'));
