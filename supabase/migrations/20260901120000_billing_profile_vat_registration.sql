-- VAT registration becomes an explicit merchant answer, not an inference from a blank field.
--
-- NOT APPLIED. Written and explained; applying it is a separate, deliberate step.
--
-- ============================================================================================
-- THE PROBLEM THIS SOLVES
-- ============================================================================================
--
-- `restaurant_billing_profiles.vat_number` is nullable and there is no registration flag. A NULL
-- therefore means two completely different things and nothing can tell them apart:
--
--     "this merchant is not VAT registered"      -- a fact, and a correct receipt has no VAT number
--     "nobody has filled this in yet"            -- a gap, and the receipt is missing something
--
-- Measured read-only on production 2026-09-01, and this is why it matters:
--
--     restaurant_billing_profiles rows           0        (for 11 venues)
--     receipts issued                        2,514
--     receipts that CHARGED VAT               1,241        Mingle 664, FNB ChowNow 554, Riviera 22
--     receipts carrying a VAT number              0
--
-- So 1,241 receipts state a VAT amount and carry no registration number, and the system cannot
-- currently say whether that is a compliance gap or the correct output for an unregistered
-- merchant. That question has to be answerable before it can be fixed, and it is not answerable
-- from the present schema.
--
-- ============================================================================================
-- WHY NULLABLE, AND WHY NOT `DEFAULT false`
-- ============================================================================================
--
-- Three states, and all three are real:
--
--     NULL   nobody has answered yet. This is EVERY venue today.
--     true   registered. A VAT number is then mandatory -- see the CHECK below.
--     false  explicitly not registered. Receipts correctly show no VAT number.
--
-- `NOT NULL DEFAULT false` would be smaller and is wrong: it would assert, silently and for all
-- eleven venues at once, that none of them is VAT registered. That is precisely the assumption
-- the ruling forbids -- "do not assume every merchant is VAT registered" cuts both ways, and
-- inventing the negative is no better than inventing the positive. A NULL says what is true
-- today: we have not asked.
--
-- ============================================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================================
--
-- It backfills NOTHING. It does not guess a value from whether a venue has a tax rate, from
-- whether its receipts charged VAT, or from its name. Those would each produce a confident answer
-- to a question only the merchant can answer.
--
-- It does not touch a single receipt. Historical snapshots record what was known at issue time,
-- and that is their job; a receipt from July cannot retroactively acquire a VAT number that did
-- not exist, and pretending otherwise would forge a tax document.
--
-- ============================================================================================
-- SEPARATE STATEMENTS, ON PURPOSE
-- ============================================================================================
--
-- The CHECK is its own ALTER rather than inline on the ADD COLUMN. An inline CHECK on
-- `ADD COLUMN IF NOT EXISTS` is SILENTLY SKIPPED when the column already exists -- the migration
-- succeeds and the constraint is never created, so the ledger and the database disagree with
-- nothing to detect it. That is issue #212, and `scripts/check-migration-inline-check.ts` is a
-- blocking CI gate for exactly this shape.

ALTER TABLE public.restaurant_billing_profiles
  ADD COLUMN IF NOT EXISTS vat_registered boolean;

COMMENT ON COLUMN public.restaurant_billing_profiles.vat_registered IS
  'Explicit merchant answer. NULL = not yet answered (never assume either way); true = registered and vat_number is mandatory; false = explicitly not registered, so receipts correctly carry no VAT number.';

-- A merchant cannot claim registration without a number. Idempotent, and a separate statement so
-- it is actually created on a re-run (#212).
ALTER TABLE public.restaurant_billing_profiles
  DROP CONSTRAINT IF EXISTS restaurant_billing_profiles_vat_number_required_when_registered;

ALTER TABLE public.restaurant_billing_profiles
  ADD CONSTRAINT restaurant_billing_profiles_vat_number_required_when_registered
  CHECK (
    vat_registered IS NOT TRUE
    OR (vat_number IS NOT NULL AND length(btrim(vat_number)) > 0)
  );
