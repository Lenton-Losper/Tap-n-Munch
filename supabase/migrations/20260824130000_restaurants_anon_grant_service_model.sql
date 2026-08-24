-- @env: both
--
-- WITHOUT THIS, ADDING THE TWO COLUMNS TO THE CLIENT SELECT BREAKS EVERY GUEST PAGE.
--
-- restaurant-context.tsx selects from `restaurants` under the ANON key, and PostgREST fails the
-- WHOLE query with 42501 if any selected column is outside the anon column grant -- it does not
-- silently omit it. The context's own comment records this happening with `owner_id`. Verified
-- again 2026-08-24 before writing this: anon SELECT of `is_counter_service` and
-- `card_payments_available` both return 42501 today.
--
-- Both columns are safe to expose and neither is a credential:
--   is_counter_service       a service model. It decides which of two signed sentences a customer
--                            reads; it is already obvious to anyone standing in the venue.
--   card_payments_available  a DERIVED boolean. It exists precisely so the client can learn whether
--                            a card may be offered WITHOUT receiving finatic_merchant_no or
--                            finatic_store_no, which stay ungranted.
--
-- Additive and forward-only: a column-level grant to a role that already reads four other columns
-- from this table.

GRANT SELECT ("is_counter_service", "card_payments_available")
  ON TABLE "public"."restaurants" TO anon, authenticated;
