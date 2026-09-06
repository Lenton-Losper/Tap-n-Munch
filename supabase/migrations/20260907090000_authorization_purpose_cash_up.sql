-- @env: both
--
-- Allow the 'cash_up' authorization purpose.
--
-- ============================================================================================
-- THE FIFTH TIME THIS CONSTRAINT HAS NEEDED CATCHING UP. IT IS WRITTEN OUT IN FULL, ON PURPOSE.
-- ============================================================================================
--
-- `lib/terminal-auth/purpose-permissions.ts` is the application's allow-list. THE DATABASE KEEPS
-- ITS OWN, on privileged_authorization_tokens.purpose, and it has now been forgotten four times:
-- service_session, then menu_availability, then walkout_close, then line_void.
--
-- The failure is silent until a person is standing at a counter. POST /api/terminal/authorize
-- passes EVERY application check -- membership, permission, PIN, lockout -- and then fails on the
-- INSERT with a 23514. The staff member types a correct PIN and is told the authorization failed.
-- Every time, with nothing in the response explaining why.
--
-- SO THIS RE-STATES THE WHOLE LIST rather than appending to it. A migration that only names the
-- new value reads as if the others are safe, and there is no way to tell from it what the
-- constraint actually ends up allowing. Written out, the next reader can diff it against
-- purpose-permissions.ts in one glance -- which is the check that keeps failing.
--
-- THE LIST THIS MIGRATION ASSUMES IT IS EXTENDING, as written by
-- 20260906120000_authorization_purpose_line_void.sql:
--
--   CHECK (purpose = ANY (ARRAY[
--     'refund', 'cash_settlement', 'service_session', 'menu_availability', 'walkout_close',
--     'line_void'
--   ]))
--
-- All six are carried forward below. 'cash_up' is the seventh and the only addition.
--
-- NOTE ON ORDERING: that migration is NOT YET APPLIED to production -- it ships with the amend
-- route gate, which is held until the terminal build that asks for a PIN exists. This migration
-- does not depend on that one having run: it DROPs the constraint by name and rebuilds it whole,
-- so applying it against the older five-value constraint produces exactly the same seven-value
-- result. That is a second reason to re-state the list rather than append to it.
--
-- ============================================================================================
-- WHAT 'cash_up' IS FOR
-- ============================================================================================
--
-- Printing the end-of-day cash-up on the terminal's own printer: takings split by cash and card,
-- gross money and order counts, everything sold, and gratuities.
--
-- IT IS THE FIRST PURPOSE HERE THAT GUARDS A READ RATHER THAN A WRITE, and the reason is the
-- hardware. A P5 sits on a bar counter for a whole service, unlocked, and this document is the
-- day's money. The terminal's own JWT belongs to the DEVICE; the PIN belongs to a person, and it
-- is a person who should be accountable for a drawer.
--
-- It maps to `reports:cash_up` -- manager and owner only. Deliberately NOT `analytics:view`,
-- which is dashboard charts on a browser somebody logged into, and deliberately NOT a reuse of
-- `tabs:close_unpaid`, which is authority to write off a debt. Both happen to be held by the same
-- two roles today; that is why reusing either would be a mistake nobody notices until the day
-- they need to differ.
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
        'line_void'::text,
        'cash_up'::text
      ]
    )
  );
