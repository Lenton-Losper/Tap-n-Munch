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
 * is never dropped, only coalesced with the noise around it).
 *
 * SET TO 45s -- MATCHING TABLE_POLL_INTERVAL_MS / ServiceFloorScreen's own REFRESH_INTERVAL_MS,
 * DELIBERATELY, NOT AN ARBITRARY "BIGGER NUMBER". An earlier version of this file set it to 2s
 * and claimed that was "no worse than" the pre-realtime poll -- wrong, caught in review: under
 * sustained flooding this fires in continuous steady state at 1/intervalMs, so 2s is a PERMANENT
 * 0.5 req/s client per terminal, seven and a half times the 45s poll's own 0.022 req/s -- at 100
 * simultaneously connected terminals that is 50 req/s sustained against
 * GET /api/terminal/tabs/{tabId}/lines versus 2.2 req/s today, indefinitely, for as long as an
 * attacker leaves a script running. Aligning the two numbers exactly means the worst case under
 * attack is IDENTICAL to today's accepted baseline at every terminal count: the realtime path can
 * only ever reduce load below that baseline (the leading-edge fire, for a real, isolated event),
 * never be forced above it. A real Out/Cooked/amend/round still reflects instantly whenever this
 * terminal has been idle 45s or more, which is true almost always in real service; several real
 * changes landing inside the same 45s window coalesce into one trailing refresh instead of each
 * getting its own near-instant push, which is the accepted trade for that ceiling.
 *
 * This does not need to be, and deliberately is not, a fix for "can a hostile client send fake
 * broadcasts at all" -- that would need the channel to stop being public, which would need the
 * terminal to hold a Supabase-Auth-shaped credential RLS could check, which is the same larger
 * change (a second identity system) the module docblock above already ruled out of scope for
 * closing this specific gap. Debouncing closes the actual harm (hammering the API) without that.
 *
 * ============================================================================================
 * UPDATED 2026-09-03 — THE CEILING NOW APPLIES TO THE PUBLIC CHANNEL ONLY
 * ============================================================================================
 *
 * The paragraph above ruled a private channel out of scope because it would need "a second
 * identity system" for RLS to check. That turned out to be wrong, and the reason is worth keeping:
 * the terminal-JWT did not need replacing, it needed PUBLISHING. Signing it ES256 and serving the
 * public half at https://flashtap.app/.well-known/jwks.json lets Supabase verify the credential the
 * terminal already carries, with no new identity, no new token lifecycle and no new login.
 *
 * So there are now TWO topics, and they are not the same channel with a flag flipped:
 *
 *   restaurant-lines:<id>          PUBLIC   — unchanged, still floodable, still debounced at 45s.
 *   restaurant-lines-private:<id>  PRIVATE  — RLS on realtime.messages, SELECT only, keyed to the
 *                                             restaurant_id claim. No INSERT policy at all, so the
 *                                             only publisher is our server's service role.
 *
 * A message on the private topic fires onInvalidate IMMEDIATELY (debounced.callNow), because the
 * flood the ceiling exists to absorb cannot happen on a channel strangers cannot publish to. The
 * public topic keeps the 45s debounce exactly as described above, and the server dual-publishes to
 * both, so a terminal on an older build loses nothing.
 *
 * Proven end to end against PRODUCTION on 2026-09-03, with the controls that matter, because a
 * denied Realtime subscription reports SUBSCRIBED and then delivers nothing forever:
 *
 *   public topic, anon                      -> SUBSCRIBED, message received   (the rig works)
 *   private topic, terminal JWT, own venue  -> SUBSCRIBED, message received   (the proof)
 *   private topic, terminal JWT, other venue-> CHANNEL_ERROR "Unauthorized: You do not have
 *                                              permissions to read from this Channel topic"
 *   private topic, anon, no token           -> CHANNEL_ERROR "Unauthorized: ..."
 *
 * WHEN THE PUBLIC SEND IS RETIRED, the debounce and this whole section go with it.
 */
import {AppState, type AppStateStatus} from 'react-native';
import {supabase, createPrivateChannelClient} from './supabase';
import {getRestaurantId, saveRestaurantId, getTerminalToken} from './storage';
import {getTerminalInfo} from './api';

export function restaurantLinesChannelName(restaurantId: string): string {
  return `restaurant-lines:${restaurantId}`;
}

/**
 * Phase B. A DIFFERENT topic, not the same one with a flag flipped -- so the unproven private
 * path cannot break the public one this terminal depends on. Contract shared with the web repo's
 * lib/stations/realtime-invalidate.ts: change one, change both.
 */
export function restaurantLinesPrivateChannelName(restaurantId: string): string {
  return `restaurant-lines-private:${restaurantId}`;
}

export const LINE_CHANGED_EVENT = 'line_changed';

/** Exported so a test can assert against the real number rather than a duplicated literal. */
export const MIN_INVALIDATE_INTERVAL_MS = 45_000;

type ChannelHealth = 'joining' | 'up' | 'down';

const DOWN_STATUSES = ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'];

function classifyStatus(status: string): ChannelHealth {
  if (status === 'SUBSCRIBED') return 'up';
  if (DOWN_STATUSES.includes(status)) return 'down';
  return 'joining';
}

/**
 * ============================================================================================
 * RESOLVING restaurantId — NOT JUST READING IT
 * ============================================================================================
 *
 * Traced during the production incident this recovery exists for: getRestaurantId() reads a
 * value written exactly once, inside activateTerminal(), at pairing time. If that write was ever
 * missed on a given device -- an interrupted activation, storage cleared by the OS, a device that
 * predates this being stored at all -- subscribeLineChangeInvalidation's own null check makes
 * that PERMANENT and SILENT: no restaurantId, no channel, no error, ever, on that device, while
 * TABLE_POLL_INTERVAL_MS / REFRESH_INTERVAL_MS's plain poll keeps working normally (it does not
 * need restaurantId), so nothing about the app looks broken. That is indistinguishable, from the
 * outside, from "realtime is slow" -- it looks identical to "realtime doesn't exist."
 *
 * resolveRestaurantId() is what every caller should use instead of getRestaurantId() directly for
 * this purpose: try storage first (free, no network), and if that comes back empty, recover it
 * from GET /api/terminal/me (getTerminalInfo, src/lib/api.ts) -- the terminal already calls this
 * route on its own regular cadence, so `restaurant_id` in its response is exactly the "authoritative
 * terminal/session/activation API response" the incident review asked this be recovered from, not
 * a new endpoint invented for the purpose. A successful recovery is written back via
 * saveRestaurantId() so the next call (next screen focus, next app launch) reads it from storage
 * again without needing the network round trip -- self-healing, not a one-time patch.
 *
 * NOT cached in memory beyond that: every call re-checks storage first, so this can never get
 * stuck returning a stale null the way the old direct getRestaurantId() call effectively could.
 * A token-less device (never activated at all) still correctly resolves to null -- there is
 * nothing to recover without a terminal to ask.
 */
export async function resolveRestaurantId(): Promise<string | null> {
  const stored = await getRestaurantId();
  if (stored) return stored;

  const token = await getTerminalToken();
  if (!token) return null;

  try {
    const info = await getTerminalInfo(token);
    const recovered = info.restaurant_id ?? info.restaurantId ?? null;
    if (recovered) {
      await saveRestaurantId(recovered);
    }
    return recovered;
  } catch {
    return null;
  }
}

/**
 * ============================================================================================
 * DIAGNOSTICS — TEMPORARY, FOR VERIFYING A PHYSICAL DEVICE IS ACTUALLY SUBSCRIBED IN PRODUCTION
 * ============================================================================================
 *
 * The production incident this exists for had no way to tell, from the device, whether Realtime
 * was connected at all -- everything server-side measured healthy, and the only evidence was
 * indirect (a poll cadence in server logs). This is that visibility, surfaced in
 * DiagnosticsScreen. `status` is the coarse read; `lastRawStatus` is the literal string Supabase
 * reported (SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED / anything else), kept alongside
 * because the coarse categories can hide exactly the distinction worth seeing while diagnosing.
 * `restaurantId` here is never a secret -- a UUID identifying the venue, already visible in that
 * venue's own public menu URL -- so surfacing it is not a credential leak.
 */
export type RealtimeDiagnosticStatus = 'idle' | 'joining' | 'subscribed' | 'reconnecting';

export type RealtimeDiagnostics = {
  status: RealtimeDiagnosticStatus;
  lastRawStatus: string | null;
  restaurantId: string | null;
  /** ISO timestamp of the last line_changed broadcast actually received this session, or null. */
  lastInvalidationAt: string | null;
  /**
   * PHASE B, KEPT SEPARATE FROM `status` ON PURPOSE. This path is expected to be denied until the
   * third-party auth provider is registered, and a probe that is supposed to be failing must not
   * make a healthy terminal read as faulty. SUBSCRIBED here proves nothing -- a denied Realtime
   * subscription reports exactly that and then delivers nothing, forever. `privateLastMessageAt`
   * is the observable that actually distinguishes working from silently denied.
   */
  privateStatus: string | null;
  privateLastMessageAt: string | null;
};

let diagnostics: RealtimeDiagnostics = {
  status: 'idle',
  lastRawStatus: null,
  restaurantId: null,
  lastInvalidationAt: null,
  privateStatus: null,
  privateLastMessageAt: null,
};
const diagnosticsListeners = new Set<() => void>();

function setDiagnostics(patch: Partial<RealtimeDiagnostics>) {
  diagnostics = {...diagnostics, ...patch};
  diagnosticsListeners.forEach(listener => listener());
}

export function getRealtimeDiagnostics(): RealtimeDiagnostics {
  return diagnostics;
}

/** Subscribe to diagnostics changes. Returns a teardown. */
export function subscribeRealtimeDiagnostics(listener: () => void): () => void {
  diagnosticsListeners.add(listener);
  return () => {
    diagnosticsListeners.delete(listener);
  };
}

/** Tests only. The store is module-level (deliberately -- see the module docblock), so it
 *  outlives any one test unless something puts it back. */
export function resetRealtimeDiagnosticsForTest(): void {
  diagnostics = {
    status: 'idle',
    lastRawStatus: null,
    restaurantId: null,
    lastInvalidationAt: null,
    privateStatus: null,
    privateLastMessageAt: null,
  };
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
    /**
     * THE CEILING DOES NOT APPLY TO A CHANNEL STRANGERS CANNOT PUBLISH TO.
     *
     * MIN_INVALIDATE_INTERVAL_MS exists for one reason, stated at length in the module docblock:
     * the PUBLIC topic accepts a message from anyone holding the anon key, which ships inside
     * every APK, so an attacker can publish fake `line_changed` events as fast as they like and
     * turn every terminal into a client hammering the API. The debounce bounds that at the
     * already-accepted 45s poll rate.
     *
     * None of that is true of the private topic. Subscribing is checked against an RLS policy
     * keyed to this terminal's own restaurant_id claim, and there is deliberately NO INSERT
     * policy, so the only party that can publish is our own server through the service role.
     * Proven end to end against production on 2026-09-03: a receipt on its own topic, and
     * "Unauthorized: You do not have permissions to read from this Channel topic" both for a
     * foreign venue's topic and for a join carrying no token at all.
     *
     * So a private message invalidates IMMEDIATELY. That is the 45 seconds coming off the number
     * staff actually feel, without giving up the protection on the channel that still needs it --
     * the public one stays, dual-published, until every client has moved.
     *
     * It also updates lastFiredAt and clears any pending trailing call, so the public copy of THE
     * SAME state change, arriving on the other channel a moment later, coalesces into this one
     * instead of firing a second refetch behind it.
     */
    callNow() {
      if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }
      fire();
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
/**
 * ============================================================================================
 * PHASE B — THE PRIVATE CHANNEL PROBE
 * ============================================================================================
 *
 * The module docblock above explains, at length, why the existing channel is public and why that
 * forces MIN_INVALIDATE_INTERVAL_MS to 45s: a public Broadcast topic accepts a message from
 * anyone holding the anon key, which ships inside every APK, so a hostile client can publish fake
 * `line_changed` messages as fast as it likes. The debounce is what stops that turning every
 * terminal into a client hammering the API. It is also, unavoidably, why a real Out or Cooked can
 * take up to 45 seconds to reach this screen during a busy service -- several genuine changes
 * inside one window coalesce into a single trailing refresh.
 *
 * That is the complaint. The ceiling is not an oversight to be tuned down; it can only come down
 * once the channel stops accepting messages from strangers.
 *
 * A PRIVATE channel is what makes that true. Subscribing is checked against an RLS policy on
 * realtime.messages keyed to the `restaurant_id` claim in this terminal's own JWT, and publishing
 * has no policy at all, so only our server (service role) can send. The flood the debounce exists
 * to absorb stops being possible.
 *
 * ============================================================================================
 * WHY IT RUNS ALONGSIDE THE PUBLIC CHANNEL AND SHARES ITS DEBOUNCE
 * ============================================================================================
 *
 * It joins a DIFFERENT topic (`restaurant-lines-private:<id>`, not the same one with a flag), so
 * it cannot affect the public subscription this terminal actually depends on. The server
 * dual-publishes to both.
 *
 * It shares the SAME debounce instance, so while both are live the terminal's refresh rate is
 * exactly what it was -- one refetch per 45s, not two. Adding a second channel must not double
 * the load, and must not change behaviour at all until the private path is proven.
 *
 * ============================================================================================
 * IT IS EXPECTED TO FAIL, AND THAT MUST NOT LOOK LIKE A FAULT
 * ============================================================================================
 *
 * Until the third-party auth provider is registered against the JWKS at
 * https://flashtap.app/.well-known/jwks.json, this terminal's JWT is not verifiable by Supabase:
 * auth.jwt() is null, the policy cannot match, and every join here is denied. Even after
 * registration the docs say to allow up to 30 minutes for a signing-key change to be picked up.
 *
 * So its status is recorded SEPARATELY from the real channel's and never merged into it. The
 * diagnostics screen's existing `status` must keep describing the feed the terminal is actually
 * running on; a probe that is supposed to be failing must not make a healthy terminal look sick.
 *
 * `privateLastMessageAt` is the field that matters. A denied Realtime subscription does not error
 * -- it reports SUBSCRIBED and delivers nothing, forever, which is the single fact that has cost
 * this project two long investigations. SUBSCRIBED here proves nothing. An ARRIVAL proves it
 * works, and the public channel is the positive control to compare it against.
 */
async function startPrivateLineProbe(
  restaurantId: string,
  onMessage: () => void,
): Promise<() => void> {
  try {
    const token = await getTerminalToken();
    if (!token) return () => {};

    // A separate client, built in ./supabase. setAuth applies to a whole CONNECTION rather than
    // one channel, so using the shared client would change the identity of the socket carrying
    // the public channel this terminal depends on.
    const client = createPrivateChannelClient();
    client.realtime.setAuth(token);

    const channel = client.channel(restaurantLinesPrivateChannelName(restaurantId), {
      config: {private: true},
    });

    channel.on('broadcast', {event: LINE_CHANGED_EVENT}, () => {
      setDiagnostics({privateLastMessageAt: new Date().toISOString()});
      onMessage();
    });

    channel.subscribe((status: string) => {
      setDiagnostics({privateStatus: status});
    });

    return () => {
      client.removeChannel(channel);
      client.realtime.disconnect();
    };
  } catch (error) {
    // A PROBE MUST NEVER BREAK THE TERMINAL. This path is expected to fail until the provider is
    // registered, and a throw here would surface as an unhandled rejection in the middle of
    // service. Recorded so it is not invisible either -- "did not run" must be distinguishable
    // from "ran and was denied". The public channel is unaffected either way.
    console.warn('[realtime] private channel probe unavailable', error);
    setDiagnostics({privateStatus: 'PROBE_UNAVAILABLE'});
    return () => {};
  }
}

export function subscribeLineChangeInvalidation(
  restaurantId: string | null,
  onInvalidate: () => void,
): () => void {
  if (!restaurantId) {
    setDiagnostics({status: 'idle', restaurantId: null});
    return () => {};
  }

  setDiagnostics({status: 'joining', restaurantId, lastRawStatus: null});

  const debounced = debouncedInvalidate(onInvalidate, MIN_INVALIDATE_INTERVAL_MS);

  let everUp = false;
  const channel = supabase.channel(restaurantLinesChannelName(restaurantId));

  channel.on('broadcast', {event: LINE_CHANGED_EVENT}, () => {
    setDiagnostics({lastInvalidationAt: new Date().toISOString()});
    debounced.call();
  });

  channel.subscribe((status: string) => {
    const health = classifyStatus(status);
    setDiagnostics({
      status: health === 'up' ? 'subscribed' : everUp ? 'reconnecting' : 'joining',
      lastRawStatus: status,
    });
    if (health === 'up') {
      if (everUp) {
        debounced.call();
      }
      everUp = true;
    }
  });

  /**
   * PHASE B, alongside the real channel and sharing its debounce -- so while both are live this
   * terminal refreshes exactly as often as it did before, never twice. Fired and forgotten
   * because resolving the token is async, and the public subscription above must not wait on it.
   */
  let stopPrivate: (() => void) | null = null;
  let privateTornDown = false;
  void startPrivateLineProbe(restaurantId, debounced.callNow).then(stop => {
    // The caller may already have unmounted while the token was resolving. Without this the
    // probe's socket would outlive its teardown and leak one connection per remount.
    if (privateTornDown) {
      stop();
      return;
    }
    stopPrivate = stop;
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
    privateTornDown = true;
    stopPrivate?.();
    setDiagnostics({status: 'idle', privateStatus: null});
  };
}
