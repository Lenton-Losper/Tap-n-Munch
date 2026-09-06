-- @env: both
--
-- Allow the 'line_void' authorization purpose.
--
-- ============================================================================================
-- THE FOURTH TIME THIS CONSTRAINT HAS NEEDED CATCHING UP. IT IS WRITTEN OUT IN FULL, ON PURPOSE.
-- ============================================================================================
--
-- `lib/terminal-auth/purpose-permissions.ts` is the application's allow-list. THE DATABASE KEEPS
-- ITS OWN, on privileged_authorization_tokens.purpose, and it has been forgotten three times:
-- service_session, then menu_availability, then walkout_close.
--
-- The failure is silent until a person is standing at a table. POST /api/terminal/authorize
-- passes EVERY application check -- membership, permission, PIN, lockout -- and then fails on the
-- INSERT with a 23514. The staff member types a correct PIN and is told the authorization failed.
-- Every time, with nothing in the response explaining why.
--
-- SO THIS RE-STATES THE WHOLE LIST rather than appending to it. A migration that only names the
-- new value reads as if the others are safe, and there is no way to tell from it what the
-- constraint actually ends up allowing. Written out, the next reader can diff it against
-- purpose-permissions.ts in one glance -- which is the check that keeps failing.
--
-- THE LIVE CONSTRAINT ON PRODUCTION, read 2026-09-06 before writing this:
--
--   CHECK (purpose = ANY (ARRAY[
--     'refund', 'cash_settlement', 'service_session', 'menu_availability', 'walkout_close'
--   ]))
--
-- All five are carried forward below. 'line_void' is the sixth and the only addition.
--
-- ============================================================================================
-- WHAT 'line_void' IS FOR
-- ============================================================================================
--
-- Voiding a line takes food off a bill after it was ordered: it reduces what the customer owes,
-- no money moves, and there is no receipt to check it against afterwards. The waiter holding the
-- terminal took the order and has the most reason to remove it, so the PIN puts a SECOND, NAMED
-- person on the record first. It maps to `orders:void` -- manager and owner only -- and NOT to
-- `orders:update`, which every waiter already holds on the terminal's own JWT.
--
-- ADDITIVE AND REVERSIBLE. Widening a CHECK cannot invalidate an existing row: every value that
-- was allowed before is still allowed. No data is written here.

ALTER TABLE public.privileged_authorization_tokens
  DROP CONSTRAINT IF EXISTS privileged_authorization_tokens_purpose_check;

ALTER TABLE public.privileged_authorization_tokens
  ADD CONSTRAINT privileged_authorization_tokens_purpose_check
  CHECK (
    purpose = ANY (
      ARRAY[
        'refund'::text,
        'cash_settlement'::text,
        'service_session'::text,
        'menu_availability'::text,
        'walkout_close'::text,
        'line_void'::text
      ]
    )
  );
