-- @env: both
--
-- THE SERVER ANSWERS THE QUESTION, THE CLIENT NEVER GETS THE CREDENTIALS.
--
-- The cart must not offer a card option at a venue that cannot take cards -- Digi Cofee and
-- Chownow Nedbank both carry NULL Finatic credentials, and the old copy promised those customers a
-- card machine at their table. The obvious fix is to let the client read finatic_merchant_no and
-- finatic_store_no and decide for itself. That would put merchant identifiers in every customer's
-- browser to answer a yes/no question, which is the same mistake #279 made with session_id.
--
-- So this is a GENERATED column: the database derives the boolean, the client selects the boolean,
-- and the credentials never leave the server. It also cannot drift -- there is no code path that
-- can set it inconsistently with the columns it is computed from.
--
-- STORED rather than VIRTUAL because PostgreSQL only supports STORED, and because a stored value is
-- indexable if a report ever needs "which venues can take cards".
--
-- Forward-only and additive. Rolling back means dropping a column nothing else writes.

ALTER TABLE "public"."restaurants"
  ADD COLUMN IF NOT EXISTS "card_payments_available" boolean
  GENERATED ALWAYS AS (
    "finatic_merchant_no" IS NOT NULL
    AND "finatic_store_no" IS NOT NULL
    AND btrim("finatic_merchant_no") <> ''
    AND btrim("finatic_store_no") <> ''
  ) STORED;

COMMENT ON COLUMN "public"."restaurants"."card_payments_available" IS
  'Derived: true when this venue has both Finatic credentials, so the card payment option may be '
  'offered. Generated so the client can read the answer without ever receiving the credentials, '
  'and so it cannot drift from the columns it is computed from. See #107 -- with no gateway public '
  'key, queryFinaticOrderPaid IS settlement and it throws without these, so a venue without them '
  'cannot take a card at all.';
