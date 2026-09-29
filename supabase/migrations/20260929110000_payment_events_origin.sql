-- @env: both
--
-- payment_events.origin / device_amount_check: WHO SAID THIS PAYMENT HAPPENED, AND DID THE AMOUNT
-- AGREE (Sprint 2026-09-29 brief, task 7).
--
-- ADDITIVE. Two nullable columns and two named CHECKs. No row is rewritten, nothing is backfilled,
-- no function is redefined. Existing rows keep NULL, which means "recorded before origin existed" --
-- never re-labelled after the fact (financial history is not rewritten).
--
-- WHY. POST /api/terminal/payment-events/sale inserts a `sale` row carrying the DEVICE's `amount`
-- and `order_ids`, even when that amount disagrees with the intent the reader was handed (it audits
-- the mismatch and records anyway -- refusing a real charge is worse). settle_order_payment writes
-- a row of the same shape into the same table after verifying the gateway. Nothing distinguished the
-- two, and lib/payments/reconcile-orphan-payments.ts read `amount` as the gateway's figure and marked
-- orders paid on it. The cron no longer does (it asks Finatic); these columns make the distinction
-- durable for every other reader.
--
--   origin               'terminal_device'  written by the device sale-event route: reported, NOT
--                                           verified. Its amount is the device's word.
--                        'gateway'          reserved for a server-written row after gateway
--                                           verification. settle_order_payment is NOT redefined
--                                           here; its rows stay NULL and are recognised by
--                                           raw_gateway_response->>'recorded_by' = 'server'
--                                           (lib/payments/reconcile-reference.ts).
--                        NULL               legacy / not stated.
--   device_amount_check  how the device's amount compared with the server's expectation when it was
--                        recorded: matched_intent | matched_order_totals | mismatch_intent |
--                        mismatch_order_totals | unchecked. NULL on every non-device row.
--
-- DEPLOY ORDER: apply BEFORE the application code. The sale route writes both columns and
-- reconcile-reference.ts selects `origin`; PostgREST refuses an absent column (PGRST204 / 42703),
-- and both paths fail closed on that (the device's report is refused with a 500 and retried; the
-- reconciliation refuses) -- safe, but an outage of the report until this is applied.

ALTER TABLE public.payment_events ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE public.payment_events ADD COLUMN IF NOT EXISTS device_amount_check text;

-- Named and added separately: an inline CHECK on ADD COLUMN IF NOT EXISTS is silently dropped when
-- the column already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payment_events_origin_known'
  ) THEN
    ALTER TABLE public.payment_events
      ADD CONSTRAINT payment_events_origin_known
      CHECK (origin IS NULL OR origin IN ('gateway', 'terminal_device'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payment_events_device_amount_check_known'
  ) THEN
    -- A device amount check only means something on a device row.
    ALTER TABLE public.payment_events
      ADD CONSTRAINT payment_events_device_amount_check_known
      CHECK (
        device_amount_check IS NULL
        OR (
          origin = 'terminal_device'
          AND device_amount_check IN (
            'matched_intent', 'matched_order_totals', 'mismatch_intent', 'mismatch_order_totals',
            'unchecked')
        )
      );
  END IF;
END
$$;

COMMENT ON COLUMN public.payment_events.origin IS
  'Who recorded this row. terminal_device = the device''s unverified report (its amount is the '
  'device''s word, never the gateway''s); gateway = server-written after gateway verification; '
  'NULL = legacy. settle_order_payment rows carry raw_gateway_response.recorded_by = server.';
COMMENT ON COLUMN public.payment_events.device_amount_check IS
  'On a terminal_device row: how the reported amount compared with the server expectation when '
  'recorded. A mismatch_* row is recorded, not authoritative.';
