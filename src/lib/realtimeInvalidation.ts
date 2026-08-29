/**
 * src/lib/realtimeInvalidation.ts — the terminal's half of "Out on the bar board should update
 * this screen immediately, not up to 15/45 seconds later."
 *
 * ============================================================================================
 * WHY BROADCAST, NOT postgres_changes ON order_lines DIRECTLY
 * ============================================================================================
 *
 * The web kitchen/bar boards already subscribe to order_lines changes directly
 * (subscribeRestaurantOrdersRealtime, Tap-n-Munch's lib/supabase/orders.ts) — that channel is
 * real, tested, and would be the obvious thing to mirror here. It cannot serve this app, though:
 * order_lines' RLS policy ("Authorized staff can read order lines") resolves through
 * auth.uid() — a Supabase Auth session. This app has never signed in to Supabase Auth. Its
 * identity is the terminal-JWT (src/lib/api.ts, verified server-side by requireTerminalAuth on
 * every REST call), and `supabase` below (src/lib/supabase.ts) holds only the anon key and has
 * never authenticated. Subscribed to order_lines directly, that client would pass the anon role
 * through RLS, the policy would deny it, and Realtime's answer to a denied subscription is not an
 * error — it is silence: a channel that reports SUBSCRIBED and delivers nothing, forever. Found by
 * reading the RLS policy and this app's own auth model, not assumed.
 *
 * Broadcast sidesteps that because it is built to: a Realtime Broadcast channel defaults to
 * `private: false` (no RLS check runs against it at all), which is only safe because the payload
 * this channel ever carries is empty — "something changed here, go re-ask the server", never line
 * data, table numbers or names. The server (Tap-n-Munch's
 * app/api/station/order-lines/[lineId]/state/route.ts, via lib/stations/realtime-invalidate.ts)
 * sends on this exact channel name after every real kitchen_state/bar_state write. The channel
 * name format (`restaurant-lines:${restaurantId}`) is a contract between that file and this one —
 * change one, change both.
 *
 * ============================================================================================
 * INVALIDATION ONLY. THE DATABASE STAYS THE SOURCE OF TRUTH.
 * ============================================================================================
 *
 * `onInvalidate` carries no data and is never read for anything but "call it." The caller's own
 * existing fetch (ServiceTableScreen's `load`, already reading the terminal-JWT-gated
 * GET /api/terminal/tabs/{tabId}/lines) is what actually answers "is this line ready now" — same
 * split the web boards already use (onLineChange triggers a refetch; the payload itself is never
 * applied to state).
 *
 * ============================================================================================
 * WHEN onInvalidate FIRES
 * ============================================================================================
 *
 *   1. A line_changed broadcast arrives — the normal, near-immediate path.
 *   2. The channel RETURNS to SUBSCRIBED after having been down. A socket that reconnects does
 *      not backfill what it missed while it was gone — Postgres/broadcast events during the gap
 *      are gone for good — so resubscribing alone would leave the screen stale while looking
 *      healthy. Same rule, same reasoning, as Tap-n-Munch's
 *      lib/dashboard/realtime-connection.ts (`everUp` / "REFETCH ON RECONNECT, NOT JUST
 *      RESUBSCRIBE"). NOT fired on the very first SUBSCRIBED — the caller's own mount-time fetch
 *      already covers that, and firing here too would double it.
 *   3. The app returns to the foreground (AppState 'active'). A backgrounded RN app's socket is
 *      not guaranteed alive, and the moment a waiter looks at the screen is the highest-value
 *      moment to be right — same idiom ServiceModelContext.tsx already uses for its own poll.
 *
 * Does NOT fire on plain visibility of the channel joining, or on every status callback — only on
 * the three events above.
 */
import {AppState, type AppStateStatus} from 'react-native';
import {supabase} from './supabase';

export function restaurantLinesChannelName(restaurantId: string): string {
  return `restaurant-lines:${restaurantId}`;
}

export const LINE_CHANGED_EVENT = 'line_changed';

type ChannelHealth = 'joining' | 'up' | 'down';

const DOWN_STATUSES = ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'];

function classifyStatus(status: string): ChannelHealth {
  if (status === 'SUBSCRIBED') return 'up';
  if (DOWN_STATUSES.includes(status)) return 'down';
  return 'joining';
}

/**
 * Subscribe one screen's worth of invalidation. One channel, not one per line/table — see the
 * module docblock.
 *
 * Safe to call with `restaurantId: null` (a no-op, returns an inert teardown) so a caller does not
 * have to gate its whole effect on an async restaurantId lookup resolving first.
 */
export function subscribeLineChangeInvalidation(
  restaurantId: string | null,
  onInvalidate: () => void,
): () => void {
  if (!restaurantId) {
    return () => {};
  }

  let everUp = false;
  const channel = supabase.channel(restaurantLinesChannelName(restaurantId));

  channel.on('broadcast', {event: LINE_CHANGED_EVENT}, () => {
    onInvalidate();
  });

  channel.subscribe((status: string) => {
    if (classifyStatus(status) === 'up') {
      if (everUp) {
        onInvalidate();
      }
      everUp = true;
    }
  });

  const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') {
      onInvalidate();
    }
  });

  return () => {
    appStateSub.remove();
    supabase.removeChannel(channel);
  };
}
