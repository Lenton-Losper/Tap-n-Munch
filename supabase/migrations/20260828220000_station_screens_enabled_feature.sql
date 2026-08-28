-- feat/station-screens-v1 -- stationScreensEnabled, default off.
--
-- Per the ruling: an authenticated-but-reused-credential route (terminal JWT, see
-- lib/stations/use-terminal-session.ts) that can show every open order in the venue must not be
-- reachable on production until the screens are finished and the station credential ships. This
-- is the per-restaurant gate the station API routes check, independent of and in addition to
-- the terminal JWT itself -- a valid terminal token for a restaurant with the flag off gets
-- refused, not served an empty board.
--
-- Same table/column shape as every other flag here (20260628130000, baseline): a plain boolean
-- on restaurant_features, NOT NULL DEFAULT false.
ALTER TABLE restaurant_features
  ADD COLUMN IF NOT EXISTS station_screens_enabled BOOLEAN NOT NULL DEFAULT false;
