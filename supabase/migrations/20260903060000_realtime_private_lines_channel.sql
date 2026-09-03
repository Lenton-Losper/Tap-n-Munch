-- =============================================================================================
-- PHASE B — THE PRIVATE INVALIDATION CHANNEL
--
-- This is the policy that lets a terminal or a wall screen RECEIVE `line_changed` on a private
-- Broadcast channel scoped to its own restaurant, using the terminal-JWT it already holds.
--
-- =============================================================================================
-- WHAT THIS IS FOR
-- =============================================================================================
--
-- The existing channel, `restaurant-lines:<id>`, is a PUBLIC broadcast: `private: false`, so no
-- RLS check runs against it. That was a deliberate and correct choice — the payload is empty, the
-- restaurant id is already public in that venue's own menu QR URL, and the real data still comes
-- from the terminal-JWT-gated REST routes. Nothing on it can lie about order state.
--
-- What it cannot do is stop a stranger holding the anon key (which ships inside every APK) from
-- PUBLISHING fake `line_changed` messages as fast as they like. Each one would make every
-- listening terminal re-fetch. That is a genuine amplification attack, and the defence against it
-- is MIN_INVALIDATE_INTERVAL_MS = 45s on the client: whatever rate messages arrive at, the
-- terminal refetches at most once per 45 seconds.
--
-- That ceiling is the thing staff are complaining about. Several real state changes inside one
-- 45s window coalesce into a single trailing refresh, so during a busy service — exactly when it
-- matters — a tap on the bar board can take up to 45 seconds to show on the till. The ceiling is
-- not a performance oversight; it is load-bearing, and it can only come down once the channel
-- stops accepting messages from anyone who asks.
--
-- A PRIVATE channel is what makes that true. Subscription is checked against this policy, and
-- publishing is restricted to the service role, so the flood the debounce exists to absorb
-- becomes impossible rather than merely survivable.
--
-- =============================================================================================
-- SELECT ONLY. THERE IS DELIBERATELY NO INSERT POLICY.
-- =============================================================================================
--
-- On a private channel, RECEIVING requires SELECT on realtime.messages and PUBLISHING requires
-- INSERT. We grant the first and not the second, on purpose.
--
-- The only legitimate publisher is our own server (lib/stations/realtime-invalidate.ts, called
-- from the one route that writes kitchen_state/bar_state), and it sends with the service role,
-- which bypasses RLS entirely and therefore needs no policy. Every other party — terminals, wall
-- screens, and anyone at all holding the anon key — has no INSERT policy to satisfy, so their
-- publishes are refused by default.
--
-- Adding a "terminals may publish to their own restaurant" INSERT policy would look symmetric and
-- would reintroduce precisely the hole this is closing: a terminal credential is a long-lived
-- token on a physical device in a bar. Read-only is the whole point.
--
-- =============================================================================================
-- WHY A SEPARATE TOPIC NAME AND NOT `private: true` ON THE EXISTING ONE
-- =============================================================================================
--
-- The migration must not be able to break the channel that currently works. Reusing the topic
-- name would mean public and private subscribers joining the same topic with different `private`
-- flags, and whether Realtime serves both correctly in that state is behaviour I have not
-- verified. This codebase has been bitten repeatedly by exactly one failure mode — a denied or
-- misconfigured subscription reports SUBSCRIBED and then delivers nothing, forever — and a wrong
-- guess here would produce that silence on the path every board and till already depends on.
--
-- With a distinct topic the two paths cannot interact. The server dual-publishes to both; each is
-- independently observable; the public one keeps working untouched no matter what the private one
-- does. When the private path is proven end to end, the public send is removed and this becomes
-- the only channel — and until then, a total failure of Phase B costs nothing.
--
-- =============================================================================================
-- THIS POLICY IS INERT UNTIL SUPABASE TRUSTS OUR JWKS
-- =============================================================================================
--
-- `auth.jwt()` only returns claims for a token this project can verify. Until the third-party auth
-- provider is registered against https://flashtap.app/.well-known/jwks.json, a terminal-JWT is not
-- verifiable here, auth.jwt() is null, the concatenation is null, the comparison is null, and the
-- policy denies. Applying this migration early is therefore safe and changes nothing: no subscriber
-- can pass it yet, and the public channel carries all traffic exactly as before.
--
-- Note also that Supabase POLLS third-party signing keys — the docs say to allow up to 30 minutes
-- for a change to be picked up — so registration is not instantaneous either.
-- =============================================================================================

-- Idempotent: this migration has to be safe to re-apply against a project where it already
-- landed, and CREATE POLICY has no IF NOT EXISTS.
drop policy if exists "Stations read line invalidations for their own restaurant" on realtime.messages;

create policy "Stations read line invalidations for their own restaurant"
on realtime.messages
for select
to authenticated
using (
  -- Broadcast only. realtime.messages also backs Presence; this policy grants nothing there.
  extension = 'broadcast'
  -- The topic must be exactly this restaurant's own. `restaurant_id` is a top-level claim minted
  -- by signTerminalJwt (lib/terminals/terminal-jwt.ts) and cannot be chosen by the client: it is
  -- signed with the private half of the key published at /.well-known/jwks.json.
  --
  -- A terminal at venue A therefore cannot subscribe to venue B by asking for its topic, which is
  -- the property the public channel never had.
  and realtime.topic() = 'restaurant-lines-private:' || ((select auth.jwt()) ->> 'restaurant_id')
);

comment on policy "Stations read line invalidations for their own restaurant" on realtime.messages is
  'Phase B: lets a terminal-JWT identity receive empty line_changed invalidations on its own '
  'restaurant''s private broadcast topic. SELECT only -- publishing stays service-role, which is '
  'what removes the 45s anti-flood debounce. Inert until the third-party auth provider is '
  'registered, since auth.jwt() is null for an untrusted issuer.';
