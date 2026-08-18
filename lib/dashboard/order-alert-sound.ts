/**
 * THE INCOMING-ORDER SOUND ALERT — policy. The tone itself lives in ./order-realtime.
 *
 * ============================================================================================
 * WHAT WAS ALREADY HERE, AND WHAT WAS WRONG WITH IT
 * ============================================================================================
 *
 * `playNewOrderSound()` already existed and was already wired to BOTH realtime subscriptions, so
 * this is repair rather than a new feature. Measured on production 2026-08-18, three faults:
 *
 *   1. ONE ORDER SOUNDED TWICE. A QR customer's submission inserts an `order_requests` row (chime
 *      one). Staff Accept then calls createOrder(), which writes an `orders` row with
 *      status 'pending' (chime two) -- on the very dashboard that just accepted it.
 *
 *   2. NO MUTE existed at all. Zero hits for mute/soundEnabled anywhere in the app.
 *
 *   3. THE UNLOCK WAS INVISIBLE. `unlockNewOrderSound` was bound to onPointerDown on the
 *      dashboard root, so audio armed itself on the first click -- but nothing ever told a staff
 *      member whether sound was on. A silent alert nobody knows is silent is worse than none.
 *
 * Not a fault, and deliberately kept: neither subscription sounds in `onInitial`, so a page load
 * is silent for orders that already existed.
 *
 * ============================================================================================
 * ONE ORDER, ONE KEY, ACROSS TWO TABLES
 * ============================================================================================
 *
 * The fix for (1) is an identity that both realtime events agree on rather than a timer or a
 * "recently sounded" heuristic:
 *
 *   order_requests INSERT            -> `req:<request.id>`
 *   orders INSERT with a source      -> `req:<order.source_request_id>`   SAME KEY
 *   orders INSERT with no source     -> `ord:<order.id>`                  (POS: sounds once)
 *
 * `app/api/order-requests/[requestId]/accept/route.ts:146` passes `sourceRequestId: requestId`
 * into createOrder, so every accepted request produces an order carrying the link. Checked rather
 * than assumed, because `customer-status.ts` records the column as "barely populated" -- that is
 * true, and it is because 994 of 1000 production orders are POS, which correctly have none.
 *
 * Keying this way suppresses the second chime for EVERY dashboard, not only the one that accepted
 * -- which is right, because it is one order either way.
 *
 * ============================================================================================
 * TWO SCREENS
 * ============================================================================================
 *
 * Ruled: two DEVICES sounding for the same order is fine -- they are in different rooms. Only the
 * double-sound WITHIN one browser is suppressed, via BroadcastChannel, and there is deliberately
 * no server-side claim.
 *
 * The residual, stated rather than hidden: two tabs receive the same realtime event over separate
 * websockets and each broadcasts as it sounds. If both process it inside the same millisecond,
 * both chime. The skew between two websocket deliveries is normally larger than a postMessage
 * round trip, so this is rare -- but it is not impossible, and the alternative (electing a leader
 * tab, or a server claim) was explicitly ruled out as too much machinery for a chime.
 */
import { playNewOrderSound, getNewOrderAudioContext } from './order-realtime'

export const ORDER_ALERT_MUTE_KEY = 'flashtap_order_alert_muted_v1'
export const ORDER_ALERT_CHANNEL_NAME = 'flashtap-order-alert-v1'

/** Which realtime table an INSERT arrived from. */
export type AlertSurface = 'orders' | 'order_requests'

export type AlertArmedState =
  /** Audio is unlocked and unmuted: an incoming order will be heard. */
  | 'armed'
  /** Unmuted, but the browser has not granted audio yet. Needs a click. */
  | 'blocked'
  /** Deliberately silenced by a staff member. */
  | 'muted'

type AlertRow = Record<string, unknown> | null | undefined

const str = (v: unknown): string => String(v ?? '').trim()

/**
 * The identity of the order an INSERT refers to, or null when the row is unusable.
 *
 * Returning null is a REFUSAL TO SOUND. A row with no id cannot be deduplicated, and a chime that
 * cannot be deduplicated is the defect this module exists to fix.
 */
export function orderAlertKey(row: AlertRow, surface: AlertSurface): string | null {
  if (!row) return null

  if (surface === 'order_requests') {
    const id = str(row.id)
    return id ? `req:${id}` : null
  }

  // An accepted request and the order it became are the same order to a person.
  const source = str(row.source_request_id)
  if (source) return `req:${source}`

  const id = str(row.id)
  return id ? `ord:${id}` : null
}

/**
 * Does this INSERT represent a NEW order a staff member has not seen?
 *
 * `orders` keeps its existing `status === 'pending'` gate: createOrder writes 'pending', and an
 * INSERT at any later status is not something arriving now. `order_requests` has no equivalent
 * filter today and none is added here -- a request is only ever inserted in one state.
 */
export function isIncomingOrderInsert(row: AlertRow, surface: AlertSurface): boolean {
  if (!row) return false
  if (surface === 'order_requests') return true
  return str(row.status).toLowerCase() === 'pending'
}

/* -------------------------------------------------------------------------- mute, persisted */

export function isOrderAlertMuted(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(ORDER_ALERT_MUTE_KEY) === '1'
  } catch {
    // Private mode or blocked storage. Default to AUDIBLE: a chime nobody asked to silence is a
    // smaller problem than silence nobody asked for.
    return false
  }
}

export function setOrderAlertMuted(muted: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ORDER_ALERT_MUTE_KEY, muted ? '1' : '0')
  } catch {
    // Non-fatal: the setting simply will not survive this refresh.
  }
  notifyArmedState()
}

/* ------------------------------------------------------------------- armed state, observable */

export function getAlertArmedState(): AlertArmedState {
  if (isOrderAlertMuted()) return 'muted'
  const ctx = getNewOrderAudioContext()
  // No context yet is the same situation as a suspended one from a staff member's point of view:
  // nothing will be heard until they interact with the page.
  if (!ctx || ctx.state === 'suspended') return 'blocked'
  return 'armed'
}

const armedListeners = new Set<() => void>()

function notifyArmedState() {
  for (const listener of armedListeners) {
    try {
      listener()
    } catch {
      // One bad subscriber must not stop the others being told.
    }
  }
}

/**
 * Subscribe to changes in whether sound will actually be heard.
 *
 * Two sources: the mute toggle, and the AudioContext's own `statechange` -- the browser can
 * suspend a context without asking, so polling the value once at mount would go stale and the
 * indicator would lie.
 */
export function subscribeAlertArmedState(listener: () => void): () => void {
  armedListeners.add(listener)
  const ctx = getNewOrderAudioContext()
  ctx?.addEventListener?.('statechange', notifyArmedState)
  return () => {
    armedListeners.delete(listener)
    ctx?.removeEventListener?.('statechange', notifyArmedState)
  }
}

/* ------------------------------------------------------------------ cross-tab de-duplication */

/**
 * Keys already sounded, BOUNDED. A busy venue inserts orders all shift and an unbounded Set would
 * grow for as long as the tab stays open -- which is the whole shift, on a dashboard that is never
 * closed. Oldest keys are evicted; re-sounding an order from hours ago is harmless, and the
 * alternative is a leak.
 */
const SEEN_LIMIT = 500
const seen = new Set<string>()

function remember(key: string) {
  seen.add(key)
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
}

let channel: BroadcastChannel | null = null
let channelReady = false

function getChannel(): BroadcastChannel | null {
  if (channelReady) return channel
  channelReady = true
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null
  try {
    channel = new BroadcastChannel(ORDER_ALERT_CHANNEL_NAME)
    channel.onmessage = (event: MessageEvent) => {
      const key = str((event?.data as { key?: unknown } | null)?.key)
      if (key) remember(key)
    }
  } catch {
    channel = null
  }
  return channel
}

/**
 * Claim the right to sound for this key in THIS tab.
 *
 * Returns false when some tab in this browser has already taken it. Marking and broadcasting
 * happen together and before the tone plays, so a sibling tab handling the same event a moment
 * later sees it taken.
 */
export function claimOrderAlert(key: string): boolean {
  if (!key || seen.has(key)) return false
  remember(key)
  try {
    getChannel()?.postMessage({ key })
  } catch {
    // A failed broadcast costs a duplicate chime in another tab, never a missed one here.
  }
  return true
}

/**
 * Mark an order as already dealt with by THIS dashboard, so its `orders` INSERT stays silent.
 *
 * Called after a staff member accepts a request. The key unification usually covers this on its
 * own -- the dashboard sounded on `req:<id>` when the request arrived -- but not when the request
 * was already on screen at page load, which is exactly the ordinary case: staff open the
 * dashboard, see something waiting, and accept it. Without this that acceptance would chime.
 */
export function suppressOrderAlert(input: { requestId?: string | null; orderId?: string | null }): void {
  const requestId = str(input.requestId)
  const orderId = str(input.orderId)
  for (const key of [requestId && `req:${requestId}`, orderId && `ord:${orderId}`]) {
    if (!key) continue
    remember(key)
    try {
      getChannel()?.postMessage({ key })
    } catch {
      // See claimOrderAlert.
    }
  }
}

/* ------------------------------------------------------------------------------- the entry point */

export type AlertOutcome = {
  /**
   * A genuinely new order this browser has not already announced. The caller shows its toast on
   * this, NOT on `sounded` -- muting is about noise, not about hiding orders, and a duplicate
   * toast is the same defect as a duplicate chime with the volume off.
   */
  notify: boolean
  /** A tone was actually played. False when muted, or when `notify` is false. */
  sounded: boolean
}

const SILENT: AlertOutcome = { notify: false, sounded: false }

/**
 * Announce an incoming order: sound for it, and tell the caller whether to surface it.
 *
 * PLAYS ONCE. Ruled: no repeat-until-acknowledged, which would need a definition of
 * acknowledgement and would change what staff are obliged to do.
 */
export function announceIncomingOrder(row: AlertRow, surface: AlertSurface): AlertOutcome {
  if (!isIncomingOrderInsert(row, surface)) return SILENT
  const key = orderAlertKey(row, surface)
  if (!key) return SILENT
  /**
   * Claim BEFORE the mute check, deliberately. A muted tab still consumes the key, so an unmuted
   * sibling tab in the same browser does not chime for an order this browser has already dealt
   * with. Muting one tab must not turn another into a second announcer.
   */
  if (!claimOrderAlert(key)) return SILENT
  if (isOrderAlertMuted()) return { notify: true, sounded: false }
  playNewOrderSound()
  return { notify: true, sounded: true }
}

/** Test seam. Never called by the app. */
export function __resetOrderAlertStateForTests(): void {
  seen.clear()
  armedListeners.clear()
  channel = null
  channelReady = false
}
