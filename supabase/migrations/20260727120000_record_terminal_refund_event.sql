-- Atomic terminal refund recording: lock the original SALE row, re-check
-- remaining refundable balance, then insert the refund event in one transaction.
-- Serializes concurrent refunds for the same origin_business_order_no.

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

  IF p_event_type = 'refund_succeeded' AND (v_prior + p_amount) > v_sale.amount THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_REMAINING:%:%:%',
      v_sale.amount, v_prior, (v_sale.amount - v_prior)
      USING ERRCODE = 'P0003';
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

GRANT EXECUTE ON FUNCTION public.record_terminal_refund_event(
  uuid, uuid[], text, text, text, text, text, numeric, text, text, uuid, text, text, text, text
) TO service_role;
