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
 *
 * ============================================================================================
 * WHY onInvalidate IS DEBOUNCED, NOT CALLED DIRECTLY
 * ============================================================================================
 *
 * The channel is a PUBLIC Broadcast (`private: false` — see the section above on why: RLS cannot
 * apply to this app's identity, and that is the whole reason this design works at all). The anon
 * key that lets a legitimate terminal listen is not a secret — it ships inside every APK — and the
 * restaurant id in the channel name is not a secret either, since it already appears in that
 * restaurant's own public menu QR URL (/menu/{restaurantId}/...). So this channel's name is
 * discoverable, not merely guessable, by anyone who wants it, and Broadcast's REST send endpoint
 * accepts a message from anyone holding the anon key — nothing here stops a hostile client from
 * publishing `line_changed` on a real restaurant's channel as fast as it likes.
 *
 * The payload carries no data, so a fake invalidation cannot lie about order state — the terminal
 * always re-asks the terminal-JWT-gated GET /api/terminal/tabs/{tabId}/lines, which is what
 * decides the truth. But a flood of fake invalidations would still turn every terminal listening
 * into a client hammering that endpoint once per fake message, which is a real amplification
 * attack even though it cannot corrupt data.
 *
 * MIN_INVALIDATE_INTERVAL_MS bounds the damage at the one place all three trigger paths funnel
 * through: whatever rate broadcasts (real or fake) arrive at, onInvalidate fires at most once per
 * interval, trailing-edge (the LAST call in a burst still lands, so a genuine final state change
 * is never dropped, only coalesced with the noise around it). Worst case under attack, this
 * behaves like a poll at MIN_INVALIDATE_INTERVAL_MS — no worse than the old 15s mitigation, and
 * the legitimate path (one real bump, no attacker) is unaffected since real bumps are not sent
 * faster than a human can tap a button.
 *
 * This does not need to be, and deliberately is not, a fix for "can a hostile client send fake
 * broadcasts at all" — that would need the channel to stop being public, which would need the
 * terminal to hold a Supabase-Auth-shaped credential RLS could check, which is the same larger
 * change (a second identity system) the module docblock above already ruled out of scope for
 * closing this specific gap. Debouncing closes the actual harm (hammering the API) without that.
 */
import {AppState, type AppStateStatus} from 'react-native';
import {supabase} from './supabase';

export function restaurantLinesChannelName(restaurantId: string): string {
  return `restaurant-lines:${restaurantId}`;
}

export const LINE_CHANGED_EVENT = 'line_changed';

/** Exported so a test can assert against the real number rather than a duplicated literal. */
export const MIN_INVALIDATE_INTERVAL_MS = 2_000;

type ChannelHealth = 'joining' | 'up' | 'down';

const DOWN_STATUSES = ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'];

function classifyStatus(status: string): ChannelHealth {
  if (status === 'SUBSCRIBED') return 'up';
  if (DOWN_STATUSES.includes(status)) return 'down';
  return 'joining';
}

/**
 * Trailing-edge debounce, deliberately not the generic "leading or trailing, configurable" kind:
 * this only ever wants trailing (the last invalidation in a burst is the one worth acting on) and
 * only ever wants one caller, so it stays a plain closure rather than a dependency.
 */
function debouncedInvalidate(onInvalidate: () => void, intervalMs: number) {
  let lastFiredAt = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;

  const fire = () => {
    lastFiredAt = Date.now();
    onInvalidate();
  };

  return {
    call() {
      const elapsed = Date.now() - lastFiredAt;
      if (elapsed >= intervalMs) {
        fire();
        return;
      }
      if (trailingTimer) return; // a trailing call is already scheduled; this burst is covered
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        fire();
      }, intervalMs - elapsed);
    },
    cancel() {
      if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }
    },
  };
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

  const debounced = debouncedInvalidate(onInvalidate, MIN_INVALIDATE_INTERVAL_MS);

  let everUp = false;
  const channel = supabase.channel(restaurantLinesChannelName(restaurantId));

  channel.on('broadcast', {event: LINE_CHANGED_EVENT}, () => {
    debounced.call();
  });

  channel.subscribe((status: string) => {
    if (classifyStatus(status) === 'up') {
      if (everUp) {
        debounced.call();
      }
      everUp = true;
    }
  });

  const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') {
      debounced.call();
    }
  });

  return () => {
    debounced.cancel();
    appStateSub.remove();
    supabase.removeChannel(channel);
  };
}
