-- @env: both
--
-- WHY THIS COLUMN EXISTS. The cart's payment-method copy told every non-kiosk customer
-- "Staff will collect cash at your table" and "Staff will bring their card machine to your table".
-- Those are assertions about how a venue OPERATES, and they were switched on `isKiosk` -- a channel
-- flag, not a service model. So a counter-service venue on the table channel promised a person who
-- was never coming, and the card line promised a card machine at venues that cannot take cards at
-- all (Digi Cofee and Chownow Nedbank both carry NULL Finatic credentials).
--
-- The service model is a property of the RESTAURANT and nothing in the schema recorded it. This
-- records it.
--
-- FORWARD-ONLY and additive: a new nullable-with-default boolean, no backfill of existing data
-- beyond the two venues named by the owner, and no change to any existing column. Rolling it back
-- means dropping a column nothing else reads.
--
-- Scoped `both` deliberately. The two headerless migrations already excluded from main
-- (20260705210000, 20260705220000) resolve to `both` BY ACCIDENT -- an absent header defaults to it
-- -- and then fail the production drift check because they are not applied there. This one is
-- scoped on purpose and is applied to both environments in the same batch, which is the difference.

ALTER TABLE "public"."restaurants"
  ADD COLUMN IF NOT EXISTS "is_counter_service" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "public"."restaurants"."is_counter_service" IS
  'True when the customer collects and pays at a counter; false when staff come to the table. '
  'Drives customer-facing payment copy -- see lib/customer-copy/menu-copy.ts. Default false '
  'because table service is the assumption the product was built on, so an unconfigured venue '
  'keeps the behaviour it already had.';

-- The two counter-service venues, named by the owner 2026-08-24. Matched on name because that is
-- what the owner identified them by, and guarded so a rename or a same-named venue in another
-- organisation cannot silently flip: this is a no-op if the name does not match exactly.
UPDATE "public"."restaurants"
  SET "is_counter_service" = true
  WHERE "name" IN ('FNB ChowNow', 'Chownow Nedbank');
