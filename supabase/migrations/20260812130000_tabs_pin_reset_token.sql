-- #265. A one-time, staff-triggered PIN recovery token.
--
-- Background. #262's containment made the PIN mandatory unconditionally -- correct, because
-- the bypass it closed (rejoin without a PIN if your session_id was already in tabs.members)
-- was reachable by anyone who could read another diner's session_id, which the anon grant on
-- tabs.members made possible for anyone holding the public key. But that bypass was also the
-- only working recovery path for a customer who lost their locally-stored PIN (device change,
-- cleared storage, #220's "View Menu" discarding the tab session). Today's answer is "staff
-- settles the whole table's tab", which is disruptive mid-meal and does not scale under load.
--
-- No staff surface reads tab_pin (grep across app/components/lib/contexts confirms this), and
-- #265's ruling keeps it that way -- the PIN is a same-party gate, not a payment credential,
-- and nothing argues for widening who can read it. So recovery cannot be "staff relays the
-- PIN". It has to be "staff triggers a re-mint that only the recovering customer's own device
-- ever sees", reusing the exact creation-time UX (mint, display once, store locally) instead
-- of inventing a new one.
--
-- pin_reset_token is the credential that makes that safe: minted with crypto.randomUUID() (not
-- Math.random, which #241 already flagged as weak for a comparable single-use code), shown to
-- the recovering customer's device only as an encoded QR staff display on their own terminal --
-- staff's screen renders the QR, never the token or the PIN in human-readable form. Consuming
-- it mints a NEW tab_pin and clears both columns in the same statement (see the application
-- code), so it is single-use by construction, not by convention.
--
-- pin_reset_token_expires_at bounds the exposure the same way terminal activation codes are
-- bounded (#241): short-lived, so a token nobody redeemed does not sit as a standing bypass.
--
-- Deliberately NOT touching tabs.session_version. A PIN reset is for ONE forgetful customer;
-- it must not invalidate every other member's already-valid session, which is what bumping
-- session_version (the staff kill-switch, #235) would do.

ALTER TABLE public.tabs
  ADD COLUMN IF NOT EXISTS pin_reset_token text,
  ADD COLUMN IF NOT EXISTS pin_reset_token_expires_at timestamptz;

COMMENT ON COLUMN public.tabs.pin_reset_token IS
  'One-time PIN-recovery credential, staff-triggered (#265). NULL when no reset is pending. '
  'Consuming it (via the join route) mints a new tab_pin and clears this column and '
  'pin_reset_token_expires_at in the same update -- single-use by construction.';

COMMENT ON COLUMN public.tabs.pin_reset_token_expires_at IS
  'Bounds pin_reset_token the way terminal activation codes are bounded (#241): an unredeemed '
  'reset expires rather than standing as a permanent bypass.';

-- Supports the redemption lookup in the join route: find the tab this token belongs to
-- without a table/restaurant scan. Partial index -- most rows have no pending reset.
CREATE INDEX IF NOT EXISTS tabs_pin_reset_token_idx
  ON public.tabs (pin_reset_token)
  WHERE pin_reset_token IS NOT NULL;
