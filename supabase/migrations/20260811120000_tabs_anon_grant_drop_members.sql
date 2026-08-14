-- #262 — take `members` (and `customer_name`) off the anon SELECT grant on public.tabs.
--
-- WHAT WAS WRONG
--
-- 20260726200000_enable_rls_tabs_restaurants_users_sessions.sql granted anon SELECT on a column
-- list that included `members`, under this policy:
--
--     CREATE POLICY "Guests can read active tabs for ordering"
--       ON public.tabs FOR SELECT TO anon
--       USING (status IN ('open', 'ready_to_pay', 'settled'));
--
-- There is no restaurant scope in that USING clause and none in the grant, so the PUBLISHED anon
-- key could read `members` on every open tab in every restaurant. `members` is a JSONB array of
-- `{ session_id, display_name, joined_at }`, and a session_id is a credential:
-- lib/guest-orders/queries.ts fetchGuestOrdersBySession returns a diner's orders when given one.
-- Enumerating the column was therefore enumerating the credential for every diner in the
-- product, unauthenticated.
--
-- `customer_name` is the same class of leak on the same row and is not read by any client. It is
-- written by app/api/tabs/route.ts and read back by that same route, which runs as service_role
-- and is unaffected by an anon grant. Every browser-client `tabs` select was enumerated by
-- CLIENT-CONSTRUCTION site (importers of lib/supabase/client.ts) rather than by grepping the
-- column name, and none of the seven names it:
--   app/menu/[restaurantId]/v2/page.tsx, app/menu/[restaurantId]/receipt/page.tsx,
--   contexts/tab-context.tsx, hooks/useSessionTokenGuard.ts, hooks/useTabSessionEndedRedirect.ts,
--   lib/tab-session.ts, lib/session-token.ts (server client despite the name).
-- __tests__/schema-constraints.test.ts does select it, through getSupabaseAdmin() — service_role.
--
-- ORDER OF OPERATIONS — THIS FILE GOES LAST, AND NOT BEFORE THE CODE IS DEPLOYED.
--
-- PostgREST refuses the ENTIRE query when the select list names an ungranted column; it does not
-- silently drop the column. Proven two-sided against production: `select tab_pin` -> 42501,
-- `select id,status,total` -> OK. Every anon read of `tabs` names its columns ALONGSIDE
-- `status`/`total`/`pin_required`, so applying this while any deployed client still asks for
-- `members` is a FULL GUEST OUTAGE — the tab screen, the receipt screen and the QR landing all
-- fail closed — not a cosmetic degradation. Code ships first, this ships last.
--
-- The client side that had to land first:
--   * app/menu/[restaurantId]/v2/page.tsx      -> GET /api/tabs/active (member_count)
--   * lib/tab-session.ts fetchActiveTabForTable -> column removed; its consumer never read it
--   * lib/tab-session.ts fetchTabById           -> GET /api/tabs/[tabId]/view
--   * contexts/tab-context.tsx loadTab          -> GET /api/tabs/[tabId]/view
-- The two seams run as service_role and substitute an opaque per-tab `member_key`
-- (lib/tab-member-key.ts) for each `session_id`, so the screens keep the display_name pairing
-- they render without ever seeing the credential.
-- __tests__/tabs-anon-select-omits-members.test.ts pins that none of them asks for it.
--
-- WHY REVOKE-THEN-REGRANT
--
-- Column-level privileges cannot be revoked one column at a time in a way that survives the
-- table-level grant, so the whole anon privilege set is dropped and the surviving columns are
-- granted back. That is 20260726200000's own idiom, reproduced here; the list below is that
-- file's list minus `members` and `customer_name`, in the same order, so a diff of the two
-- shows exactly two removals and nothing else.
--
-- Nothing here touches the policy, the `authenticated` grant or the service_role grant.

REVOKE ALL ON TABLE public.tabs FROM anon;

GRANT SELECT (
  id,
  restaurant_id,
  table_id,
  table_number,
  status,
  settled_type,
  total,
  payment_preference,
  ready_to_pay_at,
  pin_required,
  session_version,
  created_at,
  firebase_id,
  firebase_restaurant_id,
  settled_at
) ON TABLE public.tabs TO anon;
