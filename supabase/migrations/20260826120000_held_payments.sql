-- #344 RULING 3 — the durable store that makes acknowledging a held orphan payment safe.
--
-- ============================================================================================
-- WHAT THIS TABLE IS FOR
-- ============================================================================================
--
-- The terminal recovers card payments after process death. When a recovered payment does not
-- belong to the order on screen (or names no order at all), it is HELD on the device rather than
-- applied. `PaymentModule.consumeOrphanedPaymentResult` is destructive, so from that moment the
-- transaction exists in exactly one place: EncryptedStorage on one Android device.
--
-- The operator's "I have checked this payment" button then deleted it. A card transaction removed
-- by a button, with no copy anywhere.
--
-- RULED 2026-08-26: a DURABLE WRITE is the acknowledgement. Stored means released. The device
-- stores the record here and only then clears its own copy. This table is that write.
--
-- ============================================================================================
-- IT DOES NOT WAIT ON RECONCILIATION, AND THAT IS THE RULING, NOT A SHORTCUT
-- ============================================================================================
--
-- The obvious alternative was to require the payment be MATCHED to an order before the device may
-- release it. That bar cannot be met by a case-3 record -- one naming no order -- because there is
-- nothing to match it against. Under it, such a record is unclearable forever and the button
-- either lies or the list grows without bound.
--
-- "Does this exist somewhere other than the device" is a question the device can answer.
-- "Has it been reconciled" is not. So this table records the EVIDENCE, and reconciliation is a
-- separate concern that happens on its own schedule. No column here means "resolved"; adding one
-- would re-couple the device to an answer it was ruled not to wait for.
--
-- ============================================================================================
-- EVERY DEVICE-SUPPLIED COLUMN IS PERMISSIVE, DELIBERATELY
-- ============================================================================================
--
-- `orphan_order_id` and `seen_while_charging_order_id` are TEXT with no foreign key, and `reason`
-- and `outcome_kind` carry no CHECK.
--
-- THE FAILURE MODE THAT MATTERS IS A REJECTED INSERT. A constraint that refuses a row means the
-- endpoint answers non-2xx, the device treats that as "not stored" (correctly), and the operator
-- can never clear the record -- so a validation rule intended to keep the table tidy would instead
-- strand the exact transaction the table exists to preserve. An order id that does not resolve, a
-- `reason` this schema has not heard of, an APK three versions old: all of them are still evidence
-- of a card payment, and evidence is not ours to refuse.
--
-- The one column that IS constrained is `restaurant_id`, because it comes from the verified
-- terminal token rather than from the request body.
--
-- ============================================================================================
-- THE IDEMPOTENCY KEY
-- ============================================================================================
--
-- `businessOrderNo + heldAt`, as ruled. The device computes it (lib/heldOrphanStore.ts) and sends
-- it; the server stores it verbatim and uniquely per restaurant. A re-POST of the same record
-- therefore returns the SAME receipt_id rather than writing a second row.
--
-- The device's encoding is length-prefixed -- `15|FT178...|2026-08-26T09:15:00.123Z` -- because a
-- bare `a|b` join collides: ('A','B|C') and ('A|B','C') both render 'A|B|C'. Two distinct
-- transactions sharing a key would mean the second is answered "already stored" having never been
-- stored, which is the one outcome this whole mechanism exists to prevent. The server does not
-- re-derive the key; it is opaque here.

CREATE TABLE IF NOT EXISTS public.held_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- From the verified terminal token, never from the request body.
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  terminal_id text,

  -- Ruling 2. Opaque to the server; see the note above on the device's encoding.
  idempotency_key text NOT NULL,

  -- The gateway's handle on the transaction. NULLABLE: `launchPayment` requires a merchant order
  -- number so in practice every orphan carries one, but a record that arrives without one is still
  -- a record, and refusing it would be the discard this table replaces.
  business_order_no text,
  -- When the DEVICE held it, not when the server heard. The second half of the idempotency key,
  -- stored separately so it can be read and sorted without parsing the key.
  held_at timestamptz NOT NULL,

  voucher_no text,

  -- TEXT, NOT uuid, AND NO FOREIGN KEY. See the permissiveness note above: an order id that does
  -- not parse, or names an order in another restaurant, must still be recorded.
  orphan_order_id text,
  seen_while_charging_order_id text,

  -- 'different_order' | 'unknown_order' | 'non_success_not_applied' today. Uncontrained on
  -- purpose -- an APK in the field outlives any given deploy, and a value this schema has not
  -- heard of is information, not an error.
  reason text,
  outcome_kind text,

  -- The handle a human quotes. Generated server-side at first write and returned unchanged on
  -- every re-POST, so the operator who pressed the button twice sees one reference, not two.
  receipt_id text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT held_payments_idempotency_unique UNIQUE (restaurant_id, idempotency_key)
);

COMMENT ON TABLE public.held_payments IS
  'Card payments a terminal recovered but could not apply, stored durably so the device may release its only copy (#344 ruling 3). The durable write IS the acknowledgement -- nothing here means "reconciled", and no column should be added that does.';

COMMENT ON COLUMN public.held_payments.idempotency_key IS
  'businessOrderNo + heldAt, encoded by the device and opaque here. Unique per restaurant: a re-POST returns the existing receipt_id rather than writing a second row.';

COMMENT ON COLUMN public.held_payments.receipt_id IS
  'Server-generated handle returned to the device and shown to the operator. Stable across re-POSTs of the same idempotency_key.';

COMMENT ON COLUMN public.held_payments.orphan_order_id IS
  'TEXT with no FK on purpose. A device-supplied id that does not resolve is still evidence of a card payment; a rejected insert would strand the transaction this table exists to preserve.';

-- "What is outstanding at this venue" is the question a human asks.
CREATE INDEX IF NOT EXISTS held_payments_restaurant_created_idx
  ON public.held_payments (restaurant_id, created_at DESC);

-- "Do we already have this transaction?" -- asked when reconciling a gateway statement by hand.
CREATE INDEX IF NOT EXISTS held_payments_business_order_no_idx
  ON public.held_payments (business_order_no)
  WHERE business_order_no IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS: staff with payments:read may read; every write is service role.
-- ---------------------------------------------------------------------------
--
-- THE READ POLICY IS NOT OPTIONAL. A store nobody can read is the server-side version of the
-- defect this replaces -- "a hold with no consumer is the slower discard". These rows exist so a
-- person can reconcile them, and `payments:read` is the permission that person already has.
ALTER TABLE public.held_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized staff can read held payments" ON public.held_payments;
CREATE POLICY "Authorized staff can read held payments"
  ON public.held_payments
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'payments:read'));
