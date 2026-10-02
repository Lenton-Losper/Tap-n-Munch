-- ================================================================================================
-- activate_terminal_by_code: a valid activation code is sufficient to register a physical device to
-- the code's restaurant -- wherever that device was registered before.
-- ================================================================================================
--
-- POLICY (owner decision 2026-10-03, replacing F19). Restaurant B issues an activation code; a physical
-- terminal that is currently registered to restaurant A enters it; the terminal becomes B's. There is no
-- manager approval, no transfer request and no refusal because the device "belongs elsewhere": the code
-- IS the authorisation for the restaurant that issued it.
--
-- INVARIANT KEPT: exactly ONE row holds a physical device identity at any moment.
--   restaurant_terminals_device_id_unique and restaurant_terminals_device_serial_unique are NOT touched.
--   The function releases every OTHER holder of the identity before it binds the target, in one
--   transaction, so two restaurants can never operate the same device concurrently. If two activations
--   race, the row locks and the unique indexes mean one wins; the other either activates afterwards (and
--   releases the first) or fails the index and is told to retry -- never two owners.
--
-- WHAT "RELEASED" MEANS, for a row that held the identity:
--   device_id NULL, device_serial 'ft-<row id>', sn NULL        -- the physical identity is freed
--   status 'revoked', active false                              -- the old terminal row can operate nothing
--   refresh_token_hash / expiry NULL, activation_code NULL      -- its session cannot refresh
-- The row itself is KEPT, never deleted: terminal_activation_codes, privileged_authorization_tokens and
-- authorization_events reference it by foreign key and keep their history. This function writes no table
-- except restaurant_terminals and audit_logs, and never touches orders or payments.
--
-- TARGET ROW:
--   - if exactly ONE row of the code's own restaurant already holds the device (a till re-activating, or
--     a reissued code): that row is rebound and the code's own row is retired, so the till keeps its id
--     and with it every payment, printer config and audit row ever attributed to it (the 33b17639 rule);
--   - otherwise: the code's own row becomes the device's row.
--
-- AUDIT: 'terminal.activated' in the code's restaurant; 'terminal.released_by_new_activation' in each
-- restaurant that lost a registration. The old restaurant's event never names the new one.
--
-- ADDITIVE: a new function; service_role only (Supabase's default privileges grant EXECUTE on new
-- functions to anon and authenticated, so PUBLIC alone is not enough -- 20260929150000).
-- It references NO F19 column, so the F19 objects can be dropped independently afterwards.
-- ================================================================================================

CREATE OR REPLACE FUNCTION public.activate_terminal_by_code(
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
  v_same uuid[] := ARRAY[]::uuid[];
  v_all uuid[] := ARRAY[]::uuid[];
  v_target uuid;
  v_release record;
  v_released int := 0;
  v_now timestamptz := now();
BEGIN
  IF p_code_terminal_id IS NULL THEN
    RAISE EXCEPTION 'ACTIVATION_BAD_REQUEST' USING ERRCODE = 'P0001';
  END IF;

  -- The code row, locked. Everything the route checked is checked AGAIN here, under the lock.
  SELECT * INTO v_code FROM public.restaurant_terminals WHERE id = p_code_terminal_id FOR UPDATE;
  IF NOT FOUND
     OR v_code.activation_code IS NULL
     OR v_code.active IS DISTINCT FROM false
     OR v_code.activation_code_expires_at IS NULL
     OR v_code.activation_code_expires_at <= v_now THEN
    RAISE EXCEPTION 'ACTIVATION_CODE_INVALID' USING ERRCODE = 'P0001';
  END IF;

  v_identity := ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[p_device_id, p_device_serial]) AS x WHERE x IS NOT NULL AND x <> ''
  );

  -- Every OTHER row holding the identity, locked in id order (a stable order, so two concurrent
  -- activations of the same device cannot deadlock on each other's holders).
  IF coalesce(array_length(v_identity, 1), 0) > 0 THEN
    FOR v_holder IN
      SELECT id, restaurant_id
        FROM public.restaurant_terminals
       WHERE id <> v_code.id
         AND (device_id = ANY (v_identity) OR device_serial = ANY (v_identity))
       ORDER BY id
       FOR UPDATE
    LOOP
      v_all := v_all || v_holder.id;
      IF v_holder.restaurant_id = v_code.restaurant_id THEN
        v_same := v_same || v_holder.id;
      END IF;
    END LOOP;
  END IF;

  IF cardinality(v_same) = 1 THEN
    v_target := v_same[1];            -- the till keeps its row (and its history)
  ELSE
    v_target := v_code.id;
  END IF;

  -- Release every holder that is not the target, BEFORE the target takes the identity.
  FOR v_release IN
    SELECT id, restaurant_id FROM public.restaurant_terminals
     WHERE id = ANY (v_all) AND id <> v_target
     ORDER BY id
  LOOP
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
     WHERE id = v_release.id;

    INSERT INTO public.audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
    VALUES (
      v_release.restaurant_id,
      'terminal.released_by_new_activation',
      'terminal',
      v_release.id::text,
      jsonb_build_object('reason', 'device_activated_with_a_valid_code_elsewhere', 'at', v_now)
    );
    v_released := v_released + 1;
  END LOOP;

  -- Bind the target.
  UPDATE public.restaurant_terminals
     SET device_id = coalesce(nullif(p_device_id, ''), device_id),
         device_serial = coalesce(nullif(p_device_serial, ''), nullif(p_device_id, ''), device_serial, 'ft-' || id::text),
         sn = coalesce(nullif(p_sn, ''), sn),
         status = 'active',
         active = true,
         activated_at = v_now,
         last_seen_at = v_now,
         activation_code = NULL,
         activation_code_expires_at = NULL,
         refresh_token_hash = p_refresh_token_hash,
         refresh_token_expires_at = p_refresh_token_expires_at
   WHERE id = v_target;

  -- If a till was rebound, the code's own row is retired (it would otherwise keep a live code against
  -- a till that does not exist).
  IF v_target <> v_code.id THEN
    UPDATE public.restaurant_terminals
       SET status = 'revoked',
           active = false,
           activation_code = NULL,
           activation_code_expires_at = NULL
     WHERE id = v_code.id;
  END IF;

  INSERT INTO public.audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_code.restaurant_id,
    'terminal.activated',
    'terminal',
    v_target::text,
    jsonb_build_object(
      'deviceId', nullif(p_device_id, ''),
      'releasedTerminalCount', v_released,
      'reboundExisting', v_target <> v_code.id,
      'at', v_now
    )
  );

  RETURN jsonb_build_object(
    'terminalId', v_target,
    'restaurantId', v_code.restaurant_id,
    'releasedCount', v_released,
    'reboundExisting', v_target <> v_code.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.activate_terminal_by_code(uuid, text, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_terminal_by_code(uuid, text, text, text, text, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.activate_terminal_by_code(uuid, text, text, text, text, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.activate_terminal_by_code(uuid, text, text, text, text, timestamptz) TO service_role;
