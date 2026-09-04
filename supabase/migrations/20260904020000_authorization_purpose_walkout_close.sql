-- Ship 2 -- allow the 'walkout_close' authorization purpose. AND 'menu_availability', which has
-- been missing since it shipped.
--
-- ============================================================================================
-- THE SAME DEFECT AS service_session, FOUND THE SAME WAY, TWICE MORE
-- ============================================================================================
--
-- 20260827131500_authorization_purpose_service_session.sql records this exactly:
--
--   > THE DATABASE HAS ITS OWN ALLOW-LIST AND IT WAS NOT UPDATED... POST /api/terminal/authorize
--   > would pass every application-level check -- membership, permission, PIN, lockout -- and then
--   > fail on the INSERT with a 23514. The waiter would type a correct PIN and be told the
--   > authorization failed. Every time.
--
-- It happened again immediately afterwards. `menu_availability` was added to
-- lib/terminal-auth/purpose-permissions.ts and never to this constraint, so the live production
-- constraint reads:
--
--   CHECK (purpose = ANY (ARRAY['refund', 'cash_settlement', 'service_session']))
--
-- Measured on production 2026-09-04, tokens ever issued: service_session 32, refund 4,
-- menu_availability ZERO. Consistent with a feature that has never once worked -- a waiter taking a
-- dish off the menu from the P5 gets a rejected PIN, every time, and the screen cannot tell them
-- why because the failure is three layers below it.
--
-- 'walkout_close' would have been the third instance. It was caught before shipping only because
-- Ship 2 was verified BY EFFECT against production rather than by its (passing) unit tests: the
-- TypeScript map and this CHECK are two allow-lists with no compile-time relationship, and mocks
-- do not have constraints.
--
-- ============================================================================================
-- WHY menu_availability IS FIXED HERE RATHER THAN LEFT FOR ITS OWN CHANGE
-- ============================================================================================
--
-- A CHECK cannot be extended in place; it is dropped and rewritten as a complete list. So this
-- migration has to state every accepted purpose, and writing that list while deliberately omitting
-- a value that belongs in it would be re-asserting the bug in the very statement that fixes its
-- twin. There is no version of this file that touches the list and leaves menu_availability out
-- by accident -- only by choice.
--
-- DROP THEN ADD, following 20260801120000 and 20260827131500 exactly. This is a NAMED constraint
-- being replaced, so the #212 inline-CHECK hazard does not apply -- that one is about a CHECK
-- riding on ADD COLUMN IF NOT EXISTS, where the whole action skips and takes the constraint with
-- it.

ALTER TABLE public.privileged_authorization_tokens
  DROP CONSTRAINT IF EXISTS privileged_authorization_tokens_purpose_check;

ALTER TABLE public.privileged_authorization_tokens
  ADD CONSTRAINT privileged_authorization_tokens_purpose_check
  CHECK (purpose IN ('refund', 'cash_settlement', 'service_session', 'menu_availability', 'walkout_close'));

COMMENT ON COLUMN public.privileged_authorization_tokens.purpose IS
  'What the token authorises. Mirrors TERMINAL_AUTHORIZATION_PURPOSES in lib/terminal-auth/purpose-permissions.ts -- TWO ALLOW-LISTS THAT MUST BE CHANGED TOGETHER. Adding a purpose in TypeScript alone passes typecheck and every unit test, then fails at the INSERT with a 23514 and reads to the user as a rejected PIN. This has happened twice: service_session (fixed 20260827131500) and menu_availability (shipped broken, fixed 20260904020000).';
