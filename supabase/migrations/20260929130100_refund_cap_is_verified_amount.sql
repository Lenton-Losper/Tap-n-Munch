-- @env: both
--
-- record_terminal_refund_event: THE REFUND CAP IS A VERIFIED FIGURE, NEVER THE DEVICE'S WORD
-- (Sprint 2026-09-29, task 7 follow-up, lead ruling).
--
-- The function caps `refund_succeeded` at `v_sale.amount` -- the amount on the SALE row. Since
-- 20260929110000 a sale row can be the device's unverified report (origin = 'terminal_device'), whose
-- amount is whatever the device sent, recorded even when it disagreed with the intent. Capping at it
-- would let a manipulated report authorise refunding more than was ever charged.
--
-- The cap is now, in order (the same rule GET /api/terminal/payment-events/sale quotes):
--   * a VERIFIED sale row -- origin = 'gateway' (settled or promoted by settle_order_payment), or a
--     server-written row (raw_gateway_response.recorded_by = 'server')          -> its amount;
--   * a DEVICE row whose reference is an intent of this venue                  -> the intent's
--                                                                                 amount_cents / 100;
--   * a DEVICE row whose amount matched the server's expectation when recorded
--     (device_amount_check LIKE 'matched_%')                                    -> its amount;
--   * any other DEVICE row (mismatch_* / unchecked, no intent)                  -> REFUSED:
--     'SALE_AMOUNT_UNVERIFIED' (P0001; P0004 is assert_failure, which no WHEN OTHERS can catch). There is no verified figure to cap at.
--   * a LEGACY row (origin NULL, not server-written) predates the distinction   -> its amount,
--     unchanged -- financial history is not reinterpreted.
-- Only `refund_succeeded` is capped, exactly as before; `refund_failed` records no money.
--
-- Everything else is 20260727120000's body unchanged. CREATE OR REPLACE of the same signature;
-- grants restated to match 20260727120000 + 20260727130000 (service_role only). Requires
-- 20260929110000 (the origin / device_amount_check columns). SAFE TO APPLY: no table change.

CREATE OR REPLACE FUNCTION public.record_terminal_refund_event(
  p_restaurant_id uuid,
  p_order_ids uuid[],
  p_event_type text,
  p_business_order_no text,
  p_origin_business_order_no text,
  p_transaction_id text,
  p_terminal_id text,
  p_amount numeric,
  p_currency text,
  p_idempotency_key text,
  p_initiated_by uuid,
  p_reason_code text,
  p_reason_note text,
  p_gateway_result_code text,
  p_gateway_result_message text
)
RETURNS public.payment_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale public.payment_events%ROWTYPE;
  v_prior numeric;
  v_existing public.payment_events%ROWTYPE;
  v_row public.payment_events%ROWTYPE;
  v_cap numeric;
  v_intent_cents integer;
BEGIN
  IF p_event_type NOT IN ('refund_succeeded', 'refund_failed') THEN
    RAISE EXCEPTION 'INVALID_EVENT_TYPE' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotent retry under the same key.
  SELECT * INTO v_existing
  FROM public.payment_events
  WHERE restaurant_id = p_restaurant_id
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- Serialize all refunds against this SALE.
  SELECT * INTO v_sale
  FROM public.payment_events
  WHERE restaurant_id = p_restaurant_id
    AND event_type = 'sale'
    AND business_order_no = p_origin_business_order_no
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SALE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_prior
  FROM public.payment_events
  WHERE restaurant_id = p_restaurant_id
    AND event_type = 'refund_succeeded'
    AND origin_business_order_no = p_origin_business_order_no;

  IF p_event_type = 'refund_succeeded' THEN
    -- THE VERIFIED CAP. See the header for the order of the rules.
    IF v_sale.origin = 'gateway'
       OR (v_sale.origin IS NULL AND v_sale.raw_gateway_response->>'recorded_by' = 'server') THEN
      v_cap := v_sale.amount;
    ELSIF v_sale.origin = 'terminal_device' THEN
      SELECT i.amount_cents INTO v_intent_cents
        FROM public.terminal_payment_intents i
       WHERE i.merchant_order_no = p_origin_business_order_no
         AND i.restaurant_id = p_restaurant_id;
      IF v_intent_cents IS NOT NULL THEN
        v_cap := v_intent_cents::numeric / 100;
      ELSIF COALESCE(v_sale.device_amount_check, '') LIKE 'matched\_%' THEN
        v_cap := v_sale.amount;
      ELSE
        RAISE EXCEPTION 'SALE_AMOUNT_UNVERIFIED:%', v_sale.amount
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      -- Legacy: recorded before origin existed.
      v_cap := v_sale.amount;
    END IF;

    IF (v_prior + p_amount) > v_cap THEN
      RAISE EXCEPTION 'AMOUNT_EXCEEDS_REMAINING:%:%:%',
        v_cap, v_prior, (v_cap - v_prior)
        USING ERRCODE = 'P0003';
    END IF;
  END IF;

  INSERT INTO public.payment_events (
    restaurant_id,
    order_ids,
    event_type,
    business_order_no,
    origin_business_order_no,
    transaction_id,
    terminal_id,
    amount,
    currency,
    idempotency_key,
    initiated_by,
    reason_code,
    reason_note,
    gateway_result_code,
    gateway_result_message
  ) VALUES (
    p_restaurant_id,
    p_order_ids,
    p_event_type,
    p_business_order_no,
    p_origin_business_order_no,
    p_transaction_id,
    p_terminal_id,
    p_amount,
    COALESCE(NULLIF(p_currency, ''), COALESCE(v_sale.currency, 'NAD')),
    p_idempotency_key,
    p_initiated_by,
    p_reason_code,
    p_reason_note,
    p_gateway_result_code,
    p_gateway_result_message
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.record_terminal_refund_event(
  uuid, uuid[], text, text, text, text, text, numeric, text, text, uuid, text, text, text, text
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_terminal_refund_event(
  uuid, uuid[], text, text, text, text, text, numeric, text, text, uuid, text, text, text, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_terminal_refund_event(
  uuid, uuid[], text, text, text, text, text, numeric, text, text, uuid, text, text, text, text
) TO service_role;
