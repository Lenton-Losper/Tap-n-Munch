-- @env: both
--
-- A CARD ATTEMPT WHOSE OUTCOME IS UNKNOWN BLOCKS EVERY NEW CARD CHARGE FOR THE SAME ORDERS
-- (RC-RACES, sprint 2026-09-30, D4 -- raised by rc-terminal: a real double-charge path).
--
-- ================================================================================================
-- THE DEFECT
-- ================================================================================================
--
-- The P5 answered 9027 / "Not confirmed" and Finatic has no record yet (E04111). The failure route
-- rightly leaves the order pending and KEEPS the charge expectation (left_pending_finatic_uncertain:
-- E04111 means NO RECORD, never NOT PAID). But nothing stopped the next prepare. The same waiter
-- pressing Pay again, a second terminal once the 5-minute in-flight window lapsed (20260930110000),
-- the dashboard's push-to-terminal or the QR receipt route could all write a fresh expectation and
-- open a second reader -- and if the first card had in fact gone through, the customer paid twice,
-- on one merchant reference that every downstream check treats as a single charge.
--
-- ================================================================================================
-- THE MECHANISM
-- ================================================================================================
--
-- `pending_charge_unresolved_at` marks the in-flight attempt as UNRESOLVED. It is set -- by the
-- trigger below, in the same transaction -- whenever any path records
-- `payment.verification_uncertain` for an order that still carries the attempt's expectation: the
-- device's failure callback (handleTerminalPaymentFailed, both branches), "Check payment status"
-- (verify-payment), and the dashboard reconcile. One trigger instead of four call sites, so a fifth
-- writer of that audit action is covered without anyone remembering to. It marks every order of the
-- attempt (the callback names the lead only; the set shares pending_settlement_id).
--
-- While it is set, ANY write of a non-null pending_charge_cents is refused (SQLSTATE FTUNR) -- from
-- any writer, any terminal, at any age. There is deliberately no timeout: nothing resolves an
-- uncertain charge by itself (the payment-intents module's recorded ruling). What resolves it is
-- what clears the expectation:
--   * "Check payment status" finds it paid -> settled (the order is then paid; prepare refuses paid);
--   * a staff release: the dashboard's cancel-terminal, or a cash / Mark-as-Paid settlement, whose
--     release_stale_card_attempts clears an attempt older than the in-flight window (the team-lead
--     ruling of 20260929140000, unchanged);
--   * a definitive decline, which releases the attempt (the D1 rule) -- and was never marked.
-- Clearing pending_charge_cents clears the mark with it, so the legitimate retry after any of those
-- is untouched.
--
-- SAFE TO APPLY: additive. One nullable column, two functions, two triggers. No existing value is
-- changed; an attempt already uncertain before this migration is not retro-marked (its audit rows
-- predate the trigger) -- it behaves exactly as today until its next uncertain report.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pending_charge_unresolved_at timestamptz;

COMMENT ON COLUMN public.orders.pending_charge_unresolved_at IS
  'Set when the in-flight card attempt was reported uncertain (payment.verification_uncertain). While set, no new card charge may be prepared for this order (FTUNR); cleared with pending_charge_cents (20260930110100).';

-- ---- the mark ----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_marks_unresolved_card_attempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settlement uuid;
BEGIN
  SELECT o.pending_settlement_id INTO v_settlement
    FROM public.orders o
   WHERE o.id::text = NEW.entity_id
     AND o.restaurant_id = NEW.restaurant_id
     AND o.pending_charge_cents IS NOT NULL;
  IF NOT FOUND THEN
    -- No attempt in flight on this order: nothing to mark (a verify of an already-released order).
    RETURN NEW;
  END IF;

  UPDATE public.orders o
     SET pending_charge_unresolved_at = COALESCE(o.pending_charge_unresolved_at, now())
   WHERE o.restaurant_id = NEW.restaurant_id
     AND o.pending_charge_cents IS NOT NULL
     AND (o.id::text = NEW.entity_id
          OR (v_settlement IS NOT NULL AND o.pending_settlement_id = v_settlement));
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.audit_marks_unresolved_card_attempt() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.audit_marks_unresolved_card_attempt() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_marks_unresolved_card_attempt() FROM anon, authenticated;

DROP TRIGGER IF EXISTS audit_uncertain_marks_card_attempt ON public.audit_logs;
CREATE TRIGGER audit_uncertain_marks_card_attempt
  AFTER INSERT ON public.audit_logs
  FOR EACH ROW
  WHEN (NEW.action = 'payment.verification_uncertain' AND NEW.entity_type = 'order')
  EXECUTE FUNCTION public.audit_marks_unresolved_card_attempt();

-- ---- the refusal -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orders_refuse_charge_while_unresolved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.pending_charge_cents IS NULL THEN
    -- Released, settled or cancelled: the attempt is over, and so is its uncertainty.
    NEW.pending_charge_unresolved_at := NULL;
    RETURN NEW;
  END IF;

  IF OLD.pending_charge_unresolved_at IS NOT NULL AND OLD.pending_charge_cents IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'FTUNR',
      MESSAGE = format('order %s has a card payment whose outcome is unknown; no new charge until it is resolved', OLD.id),
      DETAIL  = format('unresolved since %s', OLD.pending_charge_unresolved_at),
      HINT    = 'card_attempt_unresolved';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.orders_refuse_charge_while_unresolved() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.orders_refuse_charge_while_unresolved() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orders_refuse_charge_while_unresolved() FROM anon, authenticated;

-- Named to fire BEFORE orders_charge_owned_by_one_terminal (triggers run in name order): an unknown
-- outcome is the more specific refusal, and unlike ownership it never lapses.
DROP TRIGGER IF EXISTS orders_charge_attempt_unresolved_guard ON public.orders;
CREATE TRIGGER orders_charge_attempt_unresolved_guard
  BEFORE UPDATE OF pending_charge_cents ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_refuse_charge_while_unresolved();
