/**
 * lib/stations/realtime-invalidate.ts — the ONE thing a successful order_lines state write tells
 * the outside world: "something changed here, go re-ask the server." Nothing else.
 *
 * ============================================================================================
 * WHY BROADCAST, NOT postgres_changes
 * ============================================================================================
 *
 * order_lines already carries every station board on `postgres_changes` (subscribeRestaurantOrdersRealtime,
 * lib/supabase/orders.ts) — that channel is real, tested, and exactly the shape ADR-005 §5 wanted.
 * It cannot serve the P5 terminal, though, and not for a shallow reason: `postgres_changes` is
 * gated by order_lines' own RLS policy ("Authorized staff can read order lines", USING
 * user_has_permission(restaurant_id, 'orders:read')), which resolves through auth.uid() — a
 * Supabase Auth session. The terminal has no such session. Its identity is a terminal-JWT,
 * verified server-side by requireTerminalAuth on every REST call; it has never signed in to
 * Supabase Auth, and its Supabase client (ft-settle-control's src/lib/supabase.ts) holds only the
 * anon key. Subscribed to order_lines directly, that client would pass the anon role through RLS,
 * the policy would deny it, and Realtime's answer to a denied subscription is not an error — it is
 * silence. Exactly the "publication omits a table" failure 20260827131600_realtime_order_lines.sql
 * already found and named once; the same shape, one layer up, in RLS instead of the publication.
 *
 * Building the terminal a real Supabase Auth session so postgres_changes' RLS would pass it is a
 * genuine option, and a much bigger one: a second identity system living alongside the terminal-JWT
 * it already has, its own token lifecycle, and a new question of what that session is allowed to
 * read that isn't already answered by requireTerminalAuth. Out of scope for closing this specific
 * gap.
 *
 * Broadcast sidesteps the RLS question entirely because it was built to: a Realtime Broadcast
 * channel defaults to `private: false` (confirmed against the installed @supabase/realtime-js —
 * RealtimeChannel's constructor default), which means no RLS check runs against it at all. That is
 * only safe because of the other half of this design: the payload carries NOTHING sensitive, ever.
 * No table number, no item name, no restaurant name beyond the id already used to scope the
 * channel. "Something changed" is the whole message. The actual data still comes from the
 * terminal-JWT-gated GET /api/terminal/tabs/{tabId}/lines, unchanged, which is what keeps the
 * database authoritative rather than the socket.
 *
 * ============================================================================================
 * WHY THIS FILE AND NOT A CALL INLINED AT EACH WRITE SITE
 * ============================================================================================
 *
 * There is exactly one place order_lines.kitchen_state/bar_state are ever written --
 * app/api/station/order-lines/[lineId]/state/route.ts (station-lines/batch, station-lines/[lineId]
 * and bar-rounds/[roundId] all delegate to it in-process rather than writing themselves) -- so this
 * helper has exactly one real caller. It is still its own module so the channel-naming contract
 * (restaurantLinesChannelName) is the one place both this sender and the terminal's subscriber
 * (ft-settle-control) have to agree on, and so a route test can assert a broadcast was attempted
 * without asserting anything about REST transport details.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** Same name both sides must use. Restaurant-scoped, not per-line/per-table: one channel a
 *  terminal subscribes to once per screen, covering every line change at that restaurant, matching
 *  ADR-005 §3's own "single channel, not one per row" shape for the web boards. */
export function restaurantLinesChannelName(restaurantId: string): string {
  return `restaurant-lines:${restaurantId}`
}

/**
 * THE PRIVATE TOPIC (Phase B) — A DIFFERENT NAME, not the same channel with a flag flipped.
 *
 * ============================================================================================
 * WHY A SECOND NAME RATHER THAN `private: true` ON THE FIRST
 * ============================================================================================
 *
 * The migration that grants read on this topic
 * (20260903060000_realtime_private_lines_channel.sql) carries the full reasoning; the short
 * version is that the private path must not be able to break the public one while it is being
 * proven. Reusing the topic name would put public and private subscribers on the same topic with
 * different `private` flags, and whether Realtime serves both correctly in that state is not
 * something I have verified. The failure it would produce if that guess were wrong is this
 * codebase's signature one: a subscription that reports SUBSCRIBED and then delivers nothing,
 * forever, with nothing downstream able to tell — the same silence that hid the boards' dead
 * postgres_changes feed, twice, in the docblocks above.
 *
 * Distinct names mean the two cannot interact at all, each is independently observable, and a
 * total failure of Phase B costs exactly nothing.
 *
 * WHEN THE PRIVATE PATH IS PROVEN, the public send below is deleted and this becomes the only
 * channel. That is also the point at which the 45s client debounce can come down, because the
 * reason it exists — anyone holding the anon key can publish to a public topic — stops being true.
 */
export function restaurantLinesPrivateChannelName(restaurantId: string): string {
  return `restaurant-lines-private:${restaurantId}`
}

export const LINE_CHANGED_EVENT = 'line_changed'

/**
 * Fire-and-forget, to BOTH topics. A broadcast failure must not fail the request that already
 * committed a real state change -- same trade the order_line_events audit insert two lines above
 * this call already makes, for the same reason: the write is done and correct, and answering
 * non-2xx over a best-effort notification would make a screen re-bump a line that has already
 * moved.
 *
 * ============================================================================================
 * DUAL-PUBLISH, AND WHY THE TWO SENDS ARE SETTLED INDEPENDENTLY
 * ============================================================================================
 *
 * Every listener in the estate today is on the public topic: every till on a build older than
 * this one, and every wall screen that has not been reloaded since. They keep working, unchanged,
 * for as long as this function keeps sending to both. Retiring the public send before those
 * clients have moved would strand them on their 45s/60s polls, silently.
 *
 * The two sends are settled INDEPENDENTLY rather than awaited together, because the risk is
 * asymmetric: the private topic is new, unproven, and — until the third-party auth provider is
 * registered — has no subscribers at all. A rejection there must not be able to skip the public
 * send the entire estate is currently listening to. `Promise.all` would do exactly that, and the
 * damage would show up as boards going quiet everywhere.
 *
 * They still run concurrently, so dual-publishing costs one round trip rather than two on a write
 * path that sits in a request's critical section.
 */
export async function broadcastLineChanged(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<void> {
  const send = (topic: string) => supabase.channel(topic).httpSend(LINE_CHANGED_EVENT, {})

  const [publicResult, privateResult] = await Promise.allSettled([
    send(restaurantLinesChannelName(restaurantId)),
    send(restaurantLinesPrivateChannelName(restaurantId)),
  ])

  if (publicResult.status === 'rejected') {
    console.error('[realtime-invalidate] PUBLIC broadcast failed; terminals fall back to their reconciliation poll', {
      restaurantId,
      error: publicResult.reason,
    })
  }
  if (privateResult.status === 'rejected') {
    // Logged separately, and named, so a Phase B problem is never mistaken for a regression on the
    // path the estate actually runs on.
    console.error('[realtime-invalidate] PRIVATE broadcast failed (Phase B); the public channel is unaffected', {
      restaurantId,
      error: privateResult.reason,
    })
  }
}

/**
 * THE RECEIVING HALF, for the web boards.
 *
 * ============================================================================================
 * WHY THE BOARDS NEED THIS AND NOT ONLY postgres_changes
 * ============================================================================================
 *
 * The docblock at the top of this file establishes that order_lines' `postgres_changes` feed is
 * RLS-gated through auth.uid() and that the P5 terminal, holding only a terminal-JWT, would be
 * silently denied. THE WEB BOARDS HAVE THE SAME IDENTITY. app/kitchen/page.tsx and
 * app/bar/page.tsx authenticate with the same terminal-JWT (lib/stations/use-terminal-session.ts,
 * localStorage, no Supabase Auth session anywhere), and lib/supabase/client.ts is a plain
 * createBrowserClient(url, anonKey) with no setAuth call. So a station wall screen's socket
 * authenticates as `anon`, exactly like the terminal's.
 *
 * Measured against staging on 2026-08-31, two subscribers on `orders-channel-<id>`, one real
 * order_lines UPDATE, with a service-role subscriber as the positive control:
 *
 *     [anon]         subscribe status = SUBSCRIBED   ->  0 events
 *     [service_role] subscribe status = SUBSCRIBED   ->  1 event at +686ms, old image 13 columns
 *
 * The publication is correct, REPLICA IDENTITY FULL is correct, delivery is correct. RLS is the
 * filter -- and the channel still reports SUBSCRIBED, so nothing downstream can tell. That is the
 * same silence this file's opening docblock named, one screen over from where it was fixed.
 *
 * The boards' `onLineChange` has therefore never fired in production. Their only refresh was
 * FEED_POLL_INTERVAL_MS (60s), which is why a tap appeared to do nothing for up to a minute.
 *
 * ============================================================================================
 * WHY NOT JUST GIVE order_lines AN ANON RLS POLICY
 * ============================================================================================
 *
 * Because `anon` is the public key in every browser on the internet, and a policy that lets it
 * read order_lines lets it read every venue's order lines. The boards' actual line data already
 * comes from the terminal-JWT-gated snapshot route and must keep doing so. Broadcast carries no
 * data -- "something changed at this restaurant" is the whole message -- so it is the half that
 * can safely be public.
 *
 * The `postgres_changes` subscription in app/kitchen/page.tsx and app/bar/page.tsx is deliberately
 * LEFT IN PLACE alongside this. It is not dead: a board opened on a device where a member of staff
 * IS signed in to Supabase Auth passes that policy and gets both feeds. This is the one that works
 * regardless.
 */
export function subscribeLineChanged(
  supabase: SupabaseClient,
  restaurantId: string,
  callbacks: { onLineChanged: () => void; onStatus?: (status: string) => void },
): () => void {
  const channel = supabase.channel(restaurantLinesChannelName(restaurantId))

  channel.on('broadcast', { event: LINE_CHANGED_EVENT }, () => {
    callbacks.onLineChanged()
  })

  channel.subscribe((status: string) => {
    callbacks.onStatus?.(status)
  })

  return () => {
    void supabase.removeChannel(channel)
  }
}

/**
 * THE PRIVATE RECEIVING HALF (Phase B) — same invalidation, RLS-checked, on its own socket.
 *
 * ============================================================================================
 * WHY THIS BUILDS ITS OWN CLIENT INSTEAD OF USING THE SHARED ONE
 * ============================================================================================
 *
 * Joining a private channel means the socket must present the terminal-JWT, via
 * `realtime.setAuth(token)`. That call is not scoped to a channel — it sets the access token for
 * the WHOLE realtime connection, and lib/supabase/client.ts exports a single shared browser client
 * that the boards' `postgres_changes` subscription also runs on.
 *
 * The docblock above establishes that the postgres_changes feed is dead for a board authenticated
 * only by a terminal-JWT, but ALIVE and deliberately kept for a board opened on a device where a
 * member of staff is signed in to Supabase Auth — that socket carries their session token and
 * passes order_lines' RLS. Calling setAuth on the shared client would overwrite that token with
 * the terminal-JWT and take the working feed away from exactly the users it works for. A silent
 * regression, on a path with no test, discoverable only by someone noticing a board got slower.
 *
 * So this opens a second, isolated client whose only job is this one channel. The cost is one
 * extra WebSocket per board, which is the correct price for not reaching into shared auth state.
 *
 * ============================================================================================
 * INERT UNTIL THE PROVIDER IS REGISTERED — AND IT FAILS LOUDLY, NOT SILENTLY
 * ============================================================================================
 *
 * Until Supabase is told to trust https://flashtap.app/.well-known/jwks.json, a terminal-JWT is
 * not verifiable there: auth.jwt() is null, the policy in
 * 20260903060000_realtime_private_lines_channel.sql cannot match, and this subscription is
 * refused. `onStatus` is therefore not optional decoration — it is the only way to distinguish
 * "registered and working" from "registered and silently denied", which is the distinction this
 * codebase has lost twice. Callers must dual-subscribe (public AND private) and compare, rather
 * than trusting a SUBSCRIBED that may mean nothing.
 */
export function subscribeLineChangedPrivate(
  createPrivateClient: () => SupabaseClient,
  restaurantId: string,
  terminalToken: string,
  callbacks: { onLineChanged: () => void; onStatus?: (status: string) => void },
): () => void {
  const client = createPrivateClient()

  // Must precede the join: the token is read when the channel sends its phx_join.
  client.realtime.setAuth(terminalToken)

  const channel = client.channel(restaurantLinesPrivateChannelName(restaurantId), {
    config: { private: true },
  })

  channel.on('broadcast', { event: LINE_CHANGED_EVENT }, () => {
    callbacks.onLineChanged()
  })

  channel.subscribe((status: string) => {
    callbacks.onStatus?.(status)
  })

  return () => {
    void client.removeChannel(channel)
    // This client exists solely for this channel, so its socket goes with it. Left open, every
    // board remount would leak one.
    void client.realtime.disconnect()
  }
}
