-- feat/station-screens-v1 -- pair a restaurant_terminals row to a specific station screen.
--
-- Nothing today ties an activated terminal to the SCREEN it was meant for: any activation code
-- redeems into a JWT with the same fixed permission set (lib/terminals/terminal-jwt.ts), and that
-- token works against /kitchen or /bar interchangeably. A manager "pairing a screen" needs that
-- pairing to mean something, not just be a label on a row -- station-lines and station-lines/[id]
-- and bar-rounds/[id] check this column against the screen they're serving and refuse a mismatch.
--
-- NULLABLE, and that is load-bearing: every P5 / waiter terminal has station_kind = NULL and this
-- column says nothing about them. Only a row a manager explicitly paired to a wall screen gets a
-- value, so ChowNow and Mingle, who never touch this feature, are unaffected by construction.
-- Split into independently idempotent statements (#212): an inline CHECK on
-- ADD COLUMN IF NOT EXISTS is silently skipped when the column already exists, so a re-run
-- would succeed while never creating the constraint.
ALTER TABLE restaurant_terminals
  ADD COLUMN IF NOT EXISTS station_kind text;

ALTER TABLE restaurant_terminals
  DROP CONSTRAINT IF EXISTS restaurant_terminals_station_kind_check;

ALTER TABLE restaurant_terminals
  ADD CONSTRAINT restaurant_terminals_station_kind_check
  CHECK (station_kind IN ('kitchen', 'bar'));

COMMENT ON COLUMN public.restaurant_terminals.station_kind IS
  'Which wall screen this terminal is paired to (kitchen | bar), or NULL for a P5 / waiter '
  'terminal that is not a station screen. Checked by the station API routes against the screen '
  'being served -- a kitchen-paired terminal calling ?station=bar is refused, not served.';

-- The pairing list read: "which screens does this venue have paired, and to what".
CREATE INDEX IF NOT EXISTS restaurant_terminals_station_kind_idx
  ON restaurant_terminals (restaurant_id, station_kind)
  WHERE station_kind IS NOT NULL;
