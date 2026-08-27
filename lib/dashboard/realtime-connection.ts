/**
 * WHETHER THE ORDER LIST IS ACTUALLY BEING FED. #350.
 *
 * THIS IS THE POINT OF THE MODULE, not decoration. Live Orders is the only order surface staff
 * have, and every order at every venue arrives through one Realtime subscription. When that socket
 * drops, nothing in the dashboard noticed: the list froze on whatever it last held, the 60-second
 * clock tick kept advancing the relative timestamps on that frozen data, and the new-order chime
 * lives INSIDE the subscription callback — so no event means no sound and no toast. The failure
 * presents as an empty, gently-updating screen in a quiet room, which is exactly what a genuinely
 * quiet service looks like.
 *
 * This is the same argument the incoming-order sound indicator was built on, with more force:
 * a silent alert nobody knows is silent is worse than no alert, and a dead feed loses the orders
 * themselves rather than the noise announcing them.
 *
 * THREE THINGS LIVE HERE, and they are separable on purpose:
 *
 *  1. `classifyChannelStatus` — the vocabulary. Supabase hands `.subscribe()` a status string;
 *     CHANNEL_ERROR / TIMED_OUT / CLOSED all mean "not being fed" and nothing in this repo used to
 *     read any of them.
 *
 *  2. The OBSERVABLE STATE, subscribed rather than read once, for the same reason the sound
 *     indicator subscribes: an indicator that went stale would be lying about the one thing it
 *     exists to report. Any number of channels register; the state is the WORST of them, because
 *     over-reporting a partial outage is the safe direction and under-reporting loses orders.
 *
 *  3. `startFeedFallback` — the slow poll and the visibility/online listeners, so a permanently
 *     dead socket still updates. A tab left open overnight is the NORMAL case for this screen.
 *
 * REFETCH ON RECONNECT, NOT JUST RESUBSCRIBE. This is the subtle half and the reason
 * `reportFeedChannelStatus` returns a `refetch` flag rather than just a state. A socket that comes
 * back does NOT backfill what it missed — Postgres changes during the gap are gone for good.
 * Resubscribing alone yields a list permanently missing a window of orders while looking perfectly
 * healthy: the same defect with a shorter fuse. The flag is raised only on a RETURN to SUBSCRIBED
 * (`everUp`), never on the first one, because the subscribe helper already fetches the initial
 * list — refetching there would be a duplicate query on every mount.
 */

export type FeedConnectionState =
  /** Every registered channel is subscribed. Orders are arriving as they happen. */
  | 'live'
  /** At least one channel is joining or has just dropped. Recent enough to be a blip. */
  | 'reconnecting'
  /** A channel has been down long enough that the list is only as fresh as the slow poll. */
  | 'offline'

export type FeedChannelHealth = 'joining' | 'up' | 'down'

/** The one status Supabase reports for a channel that is actually receiving. */
export const FEED_UP_STATUS = 'SUBSCRIBED'

/**
 * The statuses that mean the feed has stopped. All three were unhandled everywhere in the repo
 * before #350 — `subscribeRestaurantOrdersRealtime` forwarded them into an `onStatus` no caller
 * ever passed.
 */
export const FEED_DOWN_STATUSES = ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'] as const

/**
 * How long a channel may be down before `reconnecting` becomes `offline`.
 *
 * Short enough that a real outage is on screen within a service beat; long enough that a routine
 * rejoin does not flash an alarm at staff every time. `reconnecting` asks nothing of anybody;
 * `offline` is the state where a human has something to do.
 */
export const FEED_OFFLINE_AFTER_MS = 20_000

/**
 * The slow fallback poll. Deliberately low frequency: the requirement is that the list cannot be
 * INDEFINITELY stale, not that polling replaces the socket. It runs regardless of the reported
 * connection state, because a channel can report SUBSCRIBED and still deliver nothing.
 */
export const FEED_POLL_INTERVAL_MS = 60_000

/** Why a refetch was asked for. Callers log/branch on this; nothing is user-visible. */
export type FeedRefetchReason = 'poll' | 'visible' | 'online' | 'reconnect'

/**
 * Read a Supabase channel status. Anything unrecognised is treated as `joining` rather than `up`:
 * guessing "up" from an unknown string is the one direction that would re-create the defect.
 */
export function classifyChannelStatus(status: unknown): FeedChannelHealth {
  const value = String(status ?? '').trim().toUpperCase()
  if (!value) return 'joining'
  if (value === FEED_UP_STATUS) return 'up'
  if ((FEED_DOWN_STATUSES as readonly string[]).includes(value)) return 'down'
  return 'joining'
}

/* ------------------------------------------------------------------ observable feed state */

type ChannelEntry = {
  health: FeedChannelHealth
  /** Has this channel EVER been subscribed? Distinguishes a first join from a reconnect. */
  everUp: boolean
}

const channels = new Map<string, ChannelEntry>()
const listeners = new Set<() => void>()

let currentState: FeedConnectionState = 'reconnecting'
let degradedSince: number | null = null
let escalationTimer: ReturnType<typeof setTimeout> | null = null

function notify() {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // One bad subscriber must not stop the others being told.
    }
  }
}

function clearEscalation() {
  if (escalationTimer !== null) {
    clearTimeout(escalationTimer)
    escalationTimer = null
  }
}

function setState(next: FeedConnectionState) {
  if (next === currentState) return
  currentState = next
  notify()
}

/**
 * Derive the state from every registered channel and the length of the current outage.
 *
 * The escalation to `offline` needs its own timer: without one, a channel that drops and then says
 * nothing further would leave the indicator reading `reconnecting` forever — which is the stale
 * indicator this module exists to avoid.
 */
function recompute(now: number = Date.now()) {
  const entries = [...channels.values()]
  const allUp = entries.length > 0 && entries.every((entry) => entry.health === 'up')

  if (allUp) {
    degradedSince = null
    clearEscalation()
    setState('live')
    return
  }

  if (degradedSince === null) degradedSince = now
  const downFor = now - degradedSince

  if (downFor >= FEED_OFFLINE_AFTER_MS) {
    clearEscalation()
    setState('offline')
    return
  }

  setState('reconnecting')
  if (escalationTimer === null) {
    escalationTimer = setTimeout(() => {
      escalationTimer = null
      recompute()
    }, Math.max(0, FEED_OFFLINE_AFTER_MS - downFor))
    // Never hold a Node process open for an indicator.
    ;(escalationTimer as unknown as { unref?: () => void })?.unref?.()
  }
}

/**
 * Declare a channel this dashboard depends on. Call when the subscription is created, and call the
 * returned function when it is torn down — an unregistered channel is not counted against the
 * state, so a scope change does not leave a phantom outage behind.
 */
export function registerFeedChannel(key: string): () => void {
  channels.set(key, { health: 'joining', everUp: false })
  recompute()
  return () => {
    channels.delete(key)
    recompute()
  }
}

export type FeedStatusEffect = {
  state: FeedConnectionState
  /**
   * TRUE means the caller must REFETCH, not merely note that the socket is back. See the module
   * docblock: a returning socket does not backfill the gap.
   */
  refetch: boolean
}

/**
 * Feed one channel's `.subscribe()` status in. Returns what the caller has to do about it.
 */
export function reportFeedChannelStatus(key: string, status: unknown): FeedStatusEffect {
  const previous = channels.get(key) ?? { health: 'joining' as FeedChannelHealth, everUp: false }
  const health = classifyChannelStatus(status)

  channels.set(key, { health, everUp: previous.everUp || health === 'up' })
  recompute()

  // A RETURN to SUBSCRIBED, not the first one: the subscribe helper fetches the initial list
  // itself, so refetching on the opening SUBSCRIBED would double every mount's query.
  const refetch = health === 'up' && previous.health !== 'up' && previous.everUp

  return { state: currentState, refetch }
}

export function getFeedConnectionState(): FeedConnectionState {
  return currentState
}

/**
 * Subscribe to changes in whether the order list is being fed.
 *
 * SUBSCRIBED, NOT READ ONCE, for the reason the sound indicator is: the thing being reported
 * changes without anybody asking, and an indicator that went stale would be lying about the one
 * thing it exists to report.
 */
export function subscribeFeedConnectionState(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Drop all registered channels and return to the opening state. Tests, and a hard remount. */
export function resetFeedConnection(): void {
  channels.clear()
  clearEscalation()
  degradedSince = null
  currentState = 'reconnecting'
  listeners.clear()
}

/* ------------------------------------------------------------------------- fallback refetch */

type EventHost = {
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}

export type FeedFallbackOptions = {
  /** What to run. Must be safe to call repeatedly and concurrently with the socket. */
  refetch: (reason: FeedRefetchReason) => void
  pollIntervalMs?: number
  /** Defaults to `document.hidden`. A hidden tab is not polled; it refetches on becoming visible. */
  isHidden?: () => boolean
  /** Defaults to `document`. Injected so this is testable without a DOM. */
  visibilityHost?: EventHost | null
  /** Defaults to `window`. Carries `online`. */
  networkHost?: EventHost | null
}

function defaultHost(name: 'document' | 'window'): EventHost | null {
  const host = (globalThis as Record<string, unknown>)[name] as EventHost | undefined
  return host && typeof host.addEventListener === 'function' ? host : null
}

/**
 * Install the belt-and-braces refetches: a slow poll, `visibilitychange`, and `online`.
 *
 * WHY VISIBILITY MATTERS MOST HERE. A tab left open overnight is the normal case for this screen,
 * and browsers suspend background tabs and let their sockets die quietly. The first thing a member
 * of staff does is look at the screen — so becoming visible is the single highest-value moment to
 * refetch, and it is free.
 *
 * Returns a teardown. Idempotent to call.
 */
export function startFeedFallback(options: FeedFallbackOptions): () => void {
  const pollIntervalMs = options.pollIntervalMs ?? FEED_POLL_INTERVAL_MS
  const visibilityHost =
    options.visibilityHost === undefined ? defaultHost('document') : options.visibilityHost
  const networkHost =
    options.networkHost === undefined ? defaultHost('window') : options.networkHost

  const isHidden =
    options.isHidden ??
    (() => Boolean((globalThis as { document?: { hidden?: boolean } }).document?.hidden))

  const onPoll = () => {
    // A hidden tab does not need polling; `visibilitychange` covers the moment it matters.
    if (isHidden()) return
    options.refetch('poll')
  }

  const onVisibility = () => {
    if (isHidden()) return
    options.refetch('visible')
  }

  const onOnline = () => {
    options.refetch('online')
  }

  const timer = setInterval(onPoll, pollIntervalMs)
  ;(timer as unknown as { unref?: () => void })?.unref?.()

  visibilityHost?.addEventListener('visibilitychange', onVisibility)
  networkHost?.addEventListener('online', onOnline)

  return () => {
    clearInterval(timer)
    visibilityHost?.removeEventListener('visibilitychange', onVisibility)
    networkHost?.removeEventListener('online', onOnline)
  }
}
