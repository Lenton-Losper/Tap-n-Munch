-- ADR-005 §3 -- allow the 'service_session' authorization purpose.
--
-- NOT APPLIED BY THE AUTHORING AGENT AT AUTHORING TIME. Applied to staging during the end-to-end
-- verification that found the defect; see below.
--
-- ============================================================================================
-- WHAT WENT WRONG, AND WHY NOTHING BEFORE THE END-TO-END RUN COULD SEE IT
-- ============================================================================================
--
-- A waiter opening a table authorizes with purpose 'service_session', which was added to the
-- server-side purpose map in lib/terminal-auth/purpose-permissions.ts.
--
-- THE DATABASE HAS ITS OWN ALLOW-LIST AND IT WAS NOT UPDATED. `privileged_authorization_tokens`
-- carries `CHECK (purpose IN ('refund', 'cash_settlement'))`, so POST /api/terminal/authorize
-- would pass every application-level check -- membership, permission, PIN, lockout -- and then
-- fail on the INSERT with a 23514.
--
-- The waiter would type a correct PIN and be told the authorization failed. Every time. The
-- open-table flow could not have worked at all.
--
-- Typecheck could not see it: the TypeScript map and the CHECK constraint are two allow-lists
-- with no compile-time relationship. The unit tests could not see it: they do not touch a
-- database. It surfaced on the first real INSERT against staging, which is the argument for
-- running the sequence end to end rather than reasoning about it.
--
-- ============================================================================================
-- DROP THEN ADD, WHICH IS THE CORRECT IDIOM HERE
-- ============================================================================================
--
-- Follows 20260801120000_authorization_purpose_cash_settlement.sql exactly. This is a named
-- constraint being REPLACED, so DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT is right and the #212
-- inline-CHECK hazard does not apply -- that one is about a CHECK riding on
-- ADD COLUMN IF NOT EXISTS, where the whole action skips and takes the constraint with it.
--
-- The rewrite is the full list, not an append: a CHECK cannot be extended in place, and writing
-- out every accepted value is the only form in which this is reviewable.

ALTER TABLE public.privileged_authorization_tokens
  DROP CONSTRAINT IF EXISTS privileged_authorization_tokens_purpose_check;

ALTER TABLE public.privileged_authorization_tokens
  ADD CONSTRAINT privileged_authorization_tokens_purpose_check
  CHECK (purpose IN ('refund', 'cash_settlement', 'service_session'));

COMMENT ON COLUMN public.privileged_authorization_tokens.purpose IS
  'What the token authorises. Mirrors TERMINAL_AUTHORIZATION_PURPOSES in lib/terminal-auth/purpose-permissions.ts -- TWO ALLOW-LISTS THAT MUST BE CHANGED TOGETHER. Adding a purpose in TypeScript alone passes typecheck and every unit test, then fails at the INSERT with a 23514 and reads to the user as a rejected PIN.';
