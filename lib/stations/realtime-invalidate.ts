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

export const LINE_CHANGED_EVENT = 'line_changed'

/**
 * Fire-and-forget. A broadcast failure must not fail the request that already committed a real
 * state change -- same trade the order_line_events audit insert two lines above this call already
 * makes, for the same reason: the write is done and correct, and answering non-2xx over a
 * best-effort notification would make a screen re-bump a line that has already moved.
 */
export async function broadcastLineChanged(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<void> {
  try {
    await supabase.channel(restaurantLinesChannelName(restaurantId)).httpSend(LINE_CHANGED_EVENT, {})
  } catch (error) {
    console.error('[realtime-invalidate] broadcast failed; terminals fall back to their reconciliation poll', {
      restaurantId,
      error,
    })
  }
}
