-- @env: both
--
-- ONE CARD ATTEMPT PER ORDER AT A TIME, OWNED BY THE TERMINAL THAT PREPARED IT (RC-RACES, sprint
-- 2026-09-30, scenarios C6 / D4: two terminals take payment for the same order at the same time).
--
-- ================================================================================================
-- THE DEFECT
-- ================================================================================================
--
-- prepare-payment hands the device `orders.paycloud_merchant_order_no` -- ONE reference per order,
-- minted once and never rotated -- and writes the charge expectation (pending_charge_cents,
-- pending_settlement_id). A second terminal preparing the same order while the first terminal's
-- reader is open got HTTP 200, the SAME reference and the SAME settlement id, and launched its own
-- reader. Two cards could be charged against one reference, and every downstream correlation keys
-- on that reference:
--   * the webhook's "every order is already paid" branch treats the second confirmation as a
--     duplicate of the first (paidByAnotherPayment compares references, and they are equal);
--   * the device sale call is idempotent on the reference and returns the first row;
--   * the device callback answers ALREADY_PAID.
-- So the second charge was taken and recorded nowhere. Measured with truly concurrent requests in
-- __tests__/chaos/concurrency-races.chaos.ts (RC-C6): both prepares answered 200 with one reference.
--
-- ================================================================================================
-- THE MECHANISM
-- ================================================================================================
--
-- `pending_charge_terminal_id` records which terminal prepared the charge that is in flight.
-- prepare-payment writes it with the expectation. This trigger refuses (SQLSTATE FTOWN) a write of
-- a charge by a DIFFERENT terminal while the recorded one is still in flight -- the same 5-minute
-- window every other in-flight guard uses (orders_refuse_edit_during_charge, amend_order_lines'
-- payment_in_flight, release_stale_card_attempts, the settle route's CARD_PAYMENT_IN_FLIGHT). After
-- the window the attempt is treated as dead and another terminal may take over, exactly as cash may.
--
-- It is a TRIGGER, not a read in the route, because the race is two Workers each reading "nothing
-- in flight" and then both writing. The row lock serialises the two UPDATEs; the second one's
-- trigger sees the first one's committed owner and refuses. The route reads first as well, so the
-- common case is refused before it touches anything, but this is what makes it true under a race.
--
-- WHAT IT DOES NOT REFUSE
--   * the same terminal re-preparing (a retry, a tip added, a line voided before the reader opened);
--   * any writer that does not name a terminal (push-to-terminal, the QR receipt route, the stale
--     backfill): it leaves the column as it was, so NEW = OLD and nothing is compared;
--   * a charge whose owner is unknown (NULL: prepared before this migration);
--   * clearing the charge (settled, released, declined): the owner is cleared with it.
--
-- SAFE TO APPLY: additive. One nullable column, one function, one trigger. No existing value
-- changes. Apply BEFORE deploying the prepare-payment code that writes the column (PostgREST
-- PGRST204 otherwise); the old code keeps working against it because it never names the column.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pending_charge_terminal_id uuid;

COMMENT ON COLUMN public.orders.pending_charge_terminal_id IS
  'The terminal whose card attempt is in flight (written by prepare-payment with pending_charge_cents). Another terminal may not prepare a charge for this order until it is cleared or older than 5 minutes (20260930110000).';

CREATE OR REPLACE FUNCTION public.orders_refuse_charge_from_second_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.pending_charge_cents IS NULL THEN
    -- The attempt is over. Nobody owns a charge that does not exist.
    NEW.pending_charge_terminal_id := NULL;
    RETURN NEW;
  END IF;

  IF NEW.pending_charge_terminal_id IS NOT NULL
     AND OLD.pending_charge_cents IS NOT NULL
     AND OLD.pending_charge_terminal_id IS NOT NULL
     AND NEW.pending_charge_terminal_id <> OLD.pending_charge_terminal_id
     -- FAILS CLOSED on a missing timestamp, as orders_refuse_edit_during_charge does.
     AND (OLD.pending_charge_at IS NULL OR OLD.pending_charge_at > now() - interval '5 minutes')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'FTOWN',
      MESSAGE = format('order %s has a card payment in progress on another terminal', OLD.id),
      DETAIL  = format('owner %s since %s', OLD.pending_charge_terminal_id, OLD.pending_charge_at),
      HINT    = 'charge_in_flight_on_another_terminal';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.orders_refuse_charge_from_second_terminal() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.orders_refuse_charge_from_second_terminal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orders_refuse_charge_from_second_terminal() FROM anon, authenticated;

DROP TRIGGER IF EXISTS orders_charge_owned_by_one_terminal ON public.orders;
CREATE TRIGGER orders_charge_owned_by_one_terminal
  BEFORE UPDATE OF pending_charge_cents, pending_charge_terminal_id ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_refuse_charge_from_second_terminal();
