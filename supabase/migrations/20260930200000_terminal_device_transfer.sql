-- ================================================================================================
-- DEVICE TRANSFER: a physical terminal moves from Restaurant A to Restaurant B, atomically.
-- ================================================================================================
--
-- F19 (terminal 2.38) made a device's real ANDROID_ID occupy restaurant_terminals.device_id and
-- device_serial, and the activation route refuses a device whose identity another restaurant's row
-- holds. That refusal stays. What was missing was a way through it that does not need SQL, DevTools
-- or a manual delete in the other restaurant's account -- the 2026-09-30 FNB P5 needed all three.
--
-- THE CONSENT MODEL. No new credential is invented and none is weakened:
--   1. The device presents a VALID, UNEXPIRED activation code of Restaurant B (rate-limited, as
--      today). The route refuses it -- the device is registered elsewhere -- and records WHICH
--      device asked, on B's own code row (transfer_request_device_id / transfer_requested_at).
--   2. An authorized user of Restaurant B approves that request in the dashboard
--      (transfer_approved_at / transfer_approved_by). The approval is bound to that one device id.
--   3. The device retries with the same code. The route calls transfer_terminal_device(), which
--      re-checks the code, the expiry and the approval under row locks and, in ONE transaction:
--        - releases every row of ANOTHER restaurant holding the identity: identity cleared,
--          status revoked, active false, refresh token and any activation code cleared -- so the
--          old restaurant keeps no live session for a device it no longer has;
--        - binds the identity to B's code row and makes it active with the new refresh token;
--        - writes an audit event in BOTH restaurants (A's never names B).
--
-- Payment and order history is untouched: nothing references restaurant_terminals by foreign key
-- from the payment tables, and this function writes no other table except audit_logs.
--
-- The unique indexes on device_id and device_serial are NOT touched. They remain the guarantee that
-- two rows can never claim one device, including under concurrent transfers.
-- ================================================================================================

ALTER TABLE public.restaurant_terminals
  ADD COLUMN IF NOT EXISTS transfer_request_device_id text,
  ADD COLUMN IF NOT EXISTS transfer_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS transfer_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS transfer_approved_by uuid;

COMMENT ON COLUMN public.restaurant_terminals.transfer_request_device_id IS
  'On a pending code row: the device id that presented this code while registered to another restaurant. Self-asserted by the device; an approval is bound to it.';
COMMENT ON COLUMN public.restaurant_terminals.transfer_approved_at IS
  'On a pending code row: when an authorized user of this restaurant approved moving transfer_request_device_id here.';

CREATE OR REPLACE FUNCTION public.transfer_terminal_device(
  p_code_terminal_id uuid,
  p_device_id text,
  p_device_serial text,
  p_sn text,
  p_refresh_token_hash text,
  p_refresh_token_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code public.restaurant_terminals%ROWTYPE;
  v_identity text[];
  v_holder record;
  v_released uuid[] := ARRAY[]::uuid[];
  v_now timestamptz := now();
BEGIN
  IF p_code_terminal_id IS NULL OR coalesce(trim(p_device_id), '') = '' THEN
    RAISE EXCEPTION 'TRANSFER_BAD_REQUEST' USING ERRCODE = 'P0001';
  END IF;

  -- The code row, locked. Every condition the activation route checked is checked AGAIN here,
  -- under the lock: the route's read is not a guarantee by the time this runs.
  SELECT * INTO v_code
    FROM public.restaurant_terminals
   WHERE id = p_code_terminal_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_code.activation_code IS NULL
     OR v_code.active IS DISTINCT FROM false
     OR v_code.activation_code_expires_at IS NULL
     OR v_code.activation_code_expires_at <= v_now THEN
    RAISE EXCEPTION 'TRANSFER_CODE_INVALID' USING ERRCODE = 'P0001';
  END IF;

  IF v_code.transfer_approved_at IS NULL
     OR v_code.transfer_request_device_id IS DISTINCT FROM p_device_id THEN
    RAISE EXCEPTION 'TRANSFER_NOT_APPROVED' USING ERRCODE = 'P0001';
  END IF;

  v_identity := ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[p_device_id, p_device_serial]) AS x
     WHERE x IS NOT NULL AND x <> ''
  );

  -- Every OTHER row holding the identity, locked in id order (a stable order, so two concurrent
  -- transfers of the same device cannot deadlock on each other's holders).
  FOR v_holder IN
    SELECT id, restaurant_id
      FROM public.restaurant_terminals
     WHERE id <> v_code.id
       AND (device_id = ANY (v_identity) OR device_serial = ANY (v_identity))
     ORDER BY id
     FOR UPDATE
  LOOP
    IF v_holder.restaurant_id = v_code.restaurant_id THEN
      -- The same restaurant already owns this device: that is a re-activation, which the
      -- activation route handles by rebinding the existing row. It never reaches a transfer.
      RAISE EXCEPTION 'TRANSFER_SAME_RESTAURANT' USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.restaurant_terminals
       SET device_id = NULL,
           device_serial = 'ft-' || id::text,
           sn = NULL,
           status = 'revoked',
           active = false,
           refresh_token_hash = NULL,
           refresh_token_expires_at = NULL,
           activation_code = NULL,
           activation_code_expires_at = NULL
     WHERE id = v_holder.id;

    INSERT INTO public.audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
    VALUES (
      v_holder.restaurant_id,
      'terminal.device_transferred_out',
      'terminal',
      v_holder.id::text,
      jsonb_build_object(
        'reason', 'activated_at_another_restaurant',
        'releasedDeviceId', p_device_id,
        'at', v_now
      )
    );

    v_released := v_released || v_holder.id;
  END LOOP;

  UPDATE public.restaurant_terminals
     SET device_id = p_device_id,
         device_serial = coalesce(nullif(p_device_serial, ''), p_device_id),
         sn = coalesce(nullif(p_sn, ''), sn),
         status = 'active',
         active = true,
         activated_at = v_now,
         last_seen_at = v_now,
         activation_code = NULL,
         activation_code_expires_at = NULL,
         refresh_token_hash = p_refresh_token_hash,
         refresh_token_expires_at = p_refresh_token_expires_at,
         transfer_request_device_id = NULL,
         transfer_requested_at = NULL,
         transfer_approved_at = NULL,
         transfer_approved_by = NULL
   WHERE id = v_code.id;

  INSERT INTO public.audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_code.restaurant_id,
    'terminal.device_transferred_in',
    'terminal',
    v_code.id::text,
    jsonb_build_object(
      'deviceId', p_device_id,
      'approvedBy', v_code.transfer_approved_by,
      'releasedTerminalCount', coalesce(array_length(v_released, 1), 0),
      'at', v_now
    )
  );

  RETURN jsonb_build_object(
    'terminalId', v_code.id,
    'restaurantId', v_code.restaurant_id,
    'releasedCount', coalesce(array_length(v_released, 1), 0)
  );
END;
$$;

-- service_role only. Supabase's default privileges grant EXECUTE on new functions to anon and
-- authenticated, so revoking from PUBLIC alone leaves both able to call it (20260929150000).
REVOKE ALL ON FUNCTION public.transfer_terminal_device(uuid, text, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transfer_terminal_device(uuid, text, text, text, text, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.transfer_terminal_device(uuid, text, text, text, text, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_terminal_device(uuid, text, text, text, text, timestamptz) TO service_role;
