-- ================================================================================================
-- DROP THE F19 DEVICE-TRANSFER OBJECTS.   *** HELD: apply ONLY after the F19-removal build is live ***
-- ================================================================================================
--
-- Migration 20260930200000 added, for the Devices console's transfer-approval workflow:
--   - public.transfer_terminal_device(uuid, text, text, text, text, timestamptz)
--   - restaurant_terminals.transfer_request_device_id / transfer_requested_at /
--     transfer_approved_at / transfer_approved_by
-- The policy they served is removed (owner decision 2026-10-03): a valid activation code is sufficient,
-- and activate_terminal_by_code (20261003100000) does the whole job. Nothing in the application
-- references any of these objects any more.
--
-- WHY HELD. The build that is live today (3f9acfff) calls transfer_terminal_device() and reads/writes
-- these columns. Applying this BEFORE the F19-removal build is serving would break that build's
-- activation path. The order is therefore: apply 20261003100000 -> deploy the removal build -> soak ->
-- apply this file. Applying it earlier is a defect.
--
-- WHAT IT REMOVES, AND WHAT IT KEEPS.
--   Removes: the function and the four columns above. Irreversible for the column CONTENTS; the
--   contents are only transfer-request bookkeeping (a device id a manager was asked to approve, and
--   when). A guard below REFUSES to run if any row carries a request or an approval, so a request
--   somebody is relying on is never silently thrown away: inspect it, then decide.
--   Keeps: every terminal row, every order and payment, every audit_logs row (including any
--   'terminal.device_transferred' history). The unique indexes on device_id / device_serial are
--   untouched.
--
-- ROLLBACK TARGET after this is applied: a build that predates F19 (production version
-- 2f1de30d-571e-41f4-84ad-9b9b65f9fdc4, 682a2b2e), NOT the F19 build -- that one needs these objects.
-- ================================================================================================

DO $$
DECLARE
  v_in_use int;
BEGIN
  SELECT count(*) INTO v_in_use
    FROM public.restaurant_terminals
   WHERE transfer_request_device_id IS NOT NULL
      OR transfer_requested_at IS NOT NULL
      OR transfer_approved_at IS NOT NULL
      OR transfer_approved_by IS NOT NULL;

  IF v_in_use > 0 THEN
    RAISE EXCEPTION 'F19_DROP_REFUSED: % terminal row(s) still carry a transfer request or approval; review them before dropping', v_in_use
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.transfer_terminal_device(uuid, text, text, text, text, timestamptz);

ALTER TABLE public.restaurant_terminals
  DROP COLUMN IF EXISTS transfer_request_device_id,
  DROP COLUMN IF EXISTS transfer_requested_at,
  DROP COLUMN IF EXISTS transfer_approved_at,
  DROP COLUMN IF EXISTS transfer_approved_by;
