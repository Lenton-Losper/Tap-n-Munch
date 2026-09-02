'use client'

import { useEffect, useRef, useState } from 'react'
import { TerminalActivationGate } from '@/components/stations/terminal-activation-gate'
import { KitchenScreen } from '@/components/stations/kitchen-screen'
import { StationFaultNotice } from '@/components/stations/station-fault-notice'
import type { StationFault } from '@/lib/stations/faults'
import { StationVenueMismatch } from '@/components/stations/station-venue-mismatch'
import { readVenueHint, isVenueMismatch, type VenueHint } from '@/lib/stations/venue-hint'
import { StationLoading } from '@/components/stations/station-loading'
import { fetchInitialKitchenLines } from '@/lib/stations/data-port'
import { postStationBump } from '@/lib/stations/bump'
import { subscribeRestaurantOrdersRealtime } from '@/lib/supabase/orders'
import { supabase } from '@/lib/supabase/client'
import { subscribeLineChanged } from '@/lib/stations/realtime-invalidate'
import {
  registerFeedChannel,
  reportFeedChannelStatus,
  getFeedConnectionState,
  subscribeFeedConnectionState,
  startFeedFallback,
  type FeedConnectionState,
} from '@/lib/dashboard/realtime-connection'
import type { KitchenLine } from '@/lib/stations/types'
import type { AuthFetch, TerminalSession } from '@/lib/stations/use-terminal-session'

// Exported (not just used by KitchenPage below) so a test can mount the data-wired screen
// directly, with a fake session/authFetch, without also exercising TerminalActivationGate's own
// activation flow — that flow is a separate concern with its own tests.
export function KitchenScreenLive({ session, authFetch }: { session: TerminalSession; authFetch: AuthFetch }) {
  const [lines, setLines] = useState<KitchenLine[]>([])
  const [loading, setLoading] = useState(true)
  // One fault, not a set of booleans that can disagree with each other. See lib/stations/faults.ts.
  const [fault, setFault] = useState<StationFault | null>(null)
  /**
   * THE VENUE HINT, READ ONCE. Purely a check against what the token resolved to — see
   * lib/stations/venue-hint.ts. No hint means no opinion, and a wall screen launched from its own
   * icon carries none, so its behaviour is unchanged.
   */
  const [hint, setHint] = useState<VenueHint>({ id: null, name: null })
  const [mismatchDismissed, setMismatchDismissed] = useState(false)
  const [pairedTo, setPairedTo] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<FeedConnectionState>(getFeedConnectionState())
  const [nowMs, setNowMs] = useState(() => Date.now())

  /**
   * The live `refetch` for this session, published out of the effect that owns it so a bump can
   * call it. A ref rather than a hoisted useCallback deliberately: the effect's `cancelled` flag
   * is per-effect-run and guards its own setState calls, and hoisting the fetch would have to
   * reproduce that cancellation semantics for no gain. Reset to a no-op on teardown so a bump
   * resolving after unmount cannot start a fetch nobody will read.
   */
  const refetchRef = useRef<() => void>(() => {})

  /* eslint-disable react-hooks/set-state-in-effect -- one-time read of the launch URL on mount */
  useEffect(() => {
    setHint(readVenueHint(typeof window === 'undefined' ? '' : window.location.search))
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => subscribeFeedConnectionState(() => setConnectionState(getFeedConnectionState())), [])

  // Same #350 pattern as orders-dashboard.tsx: ticks a clock only, never refetches.
  //
  // 1s, not 30s. This used to be 30s, back when the clock only had to catch escalation-band
  // colour crossings (5/10/20 minute thresholds -- 30s of slack there is invisible). The board
  // redesign then put formatElapsedClock's MM:SS directly on screen, second-resolution, and a
  // 30s tick made that render sit frozen for up to half a minute and then visibly jump -- the
  // wall clock nobody trusts. The escalation bands still update on every tick same as before;
  // this only changes how often that tick happens.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [])

  // last_seen_at (paired-screens list, Settings -> Payment & terminals) only moves when
  // something calls this. Without it, a wall screen that has been up for a week still reads
  // "last seen: at activation" -- exactly the silent-staleness failure #350 exists to prevent,
  // one column over. The route is generic (app/api/terminal/heartbeat) and already used by other
  // terminal clients; this just means the current terminal is also one of them.
  useEffect(() => {
    const beat = () => void authFetch('/api/terminal/heartbeat', { method: 'POST' })
    beat()
    const id = window.setInterval(beat, 60_000)
    return () => window.clearInterval(id)
  }, [authFetch])

  useEffect(() => {
    let cancelled = false
    const channelKey = `station-kitchen:${session.terminalId}`

    const refetch = () => {
      void fetchInitialKitchenLines(authFetch).then((snapshot) => {
        if (cancelled) return
        setLines(snapshot.items)
        setFault(snapshot.fault)
        setPairedTo(snapshot.pairedTo)
        setLoading(false)
      })
    }

    refetchRef.current = refetch
    refetch()

    // Ruled: reuse subscribeRestaurantOrdersRealtime (lib/supabase/orders.ts) rather than a
    // second subscriber — it already carries #350's CHANNEL_ERROR/TIMED_OUT/CLOSED handling,
    // visibility refetch and 60s poll fallback. Extended with `onLineChange` for order_lines
    // rather than forked. `onLineChange`'s payload is deliberately NOT read here — it is only
    // "something changed, refetch" (same as reconnect's `refetch` flag below); the actual line
    // data still comes from the terminal-JWT + stationScreensEnabled-gated snapshot route
    // (lib/stations/data-port.ts), which is the boundary that must not be bypassed by URL.
    const unregister = registerFeedChannel(channelKey)
    const unsubscribe = subscribeRestaurantOrdersRealtime(session.restaurantId, {
      onLineChange: refetch,
      onStatus: (status) => {
        const { refetch: shouldRefetch } = reportFeedChannelStatus(channelKey, status)
        if (shouldRefetch) refetch()
      },
    })

    /**
     * THE FEED THAT ACTUALLY REACHES THIS SCREEN. See subscribeLineChanged's own docblock: the
     * postgres_changes subscription above is RLS-gated through auth.uid(), and a station wall
     * screen has no Supabase Auth session — only the terminal-JWT — so its socket is `anon` and
     * Realtime answers a denied subscription with silence, not an error. Measured: SUBSCRIBED,
     * zero events. This restaurant-scoped Broadcast carries no data and no RLS check, so it is
     * the one that lands.
     *
     * REGISTERED AS ITS OWN FEED CHANNEL, which is the point rather than bookkeeping. The
     * connection indicator takes the WORST of every registered channel, so a broadcast that
     * fails to join now shows as degraded instead of being masked by a postgres_changes channel
     * that reports SUBSCRIBED while delivering nothing to this screen. The whole defect being
     * fixed here is an indicator that read `live` over a dead feed; wiring the replacement in
     * without registering it would rebuild exactly that.
     */
    const broadcastKey = `station-kitchen-broadcast:${session.terminalId}`
    const unregisterBroadcast = registerFeedChannel(broadcastKey)
    const unsubscribeBroadcast = subscribeLineChanged(supabase, session.restaurantId, {
      onLineChanged: refetch,
      onStatus: (status) => {
        const { refetch: shouldRefetch } = reportFeedChannelStatus(broadcastKey, status)
        if (shouldRefetch) refetch()
      },
    })

    const stopFallback = startFeedFallback({ refetch })

    return () => {
      cancelled = true
      refetchRef.current = () => {}
      unregister()
      unsubscribe()
      unregisterBroadcast()
      unsubscribeBroadcast()
      stopFallback()
    }
  }, [session.restaurantId, session.terminalId, authFetch])

  if (loading) {
    return <StationLoading />
  }
  /**
   * BEFORE the board and before any fault state: if the dashboard named one venue and the token
   * resolved to another, that disagreement is the most important thing on this screen. It is not
   * an error — the board below is correct — so it is dismissible.
   */
  if (isVenueMismatch(hint, session.restaurantId) && !mismatchDismissed) {
    return (
      <StationVenueMismatch
        station="kitchen"
        showingVenueName={session.restaurantName}
        openedFromVenueName={hint.name}
        onContinue={() => setMismatchDismissed(true)}
      />
    )
  }

  if (fault) {
    return <StationFaultNotice fault={fault} pairedTo={pairedTo} station="kitchen" venueName={session.restaurantName} />
  }

  /**
   * ONE call for one line and for a whole table alike — see lib/stations/bump.ts. Both used to be
   * fire-and-forget `void authFetch(...)`, which meant a bump the server REFUSED produced no
   * visible effect at all: the line stayed on the board and the cook's only signal was that tapping
   * it again also did nothing. The outcome is now returned to the card, which marks the rows that
   * did not move.
   */
  return (
    <KitchenScreen
      venueName={session.restaurantName}
      lines={lines}
      now={nowMs}
      connectionState={connectionState}
      onBump={async (lineIds, action) => {
        const outcome = await postStationBump(authFetch, 'kitchen', lineIds, action)
        /**
         * RE-ASK THE SERVER, ALWAYS, AND DO NOT PAINT THE ANSWER LOCALLY.
         *
         * The tap's own screen used to depend on a socket to learn about its own write: nothing
         * here refetched, so the board sat on stale state until the Broadcast landed or, before
         * that subscription existed, until FEED_POLL_INTERVAL_MS (60s). That is the "I pressed it
         * and nothing happened" report.
         *
         * Unconditional, including on failure and on a 409: every non-success outcome means the
         * board's belief about that line is in question -- LINE_CHANGED specifically means
         * somebody else already moved it -- and a refetch is the cheap way to stop guessing.
         *
         * This does not construct any state client-side. `outcome` is returned to the card
         * untouched (it still marks the rows that would not move) and the rendered lines still
         * come only from the terminal-JWT-gated snapshot route, so the database stays the single
         * authority. It removes a wait, not a round trip.
         */
        refetchRef.current()
        return outcome
      }}
    />
  )
}

export default function KitchenPage() {
  return (
    <TerminalActivationGate station="kitchen">
      {(session, authFetch) => <KitchenScreenLive session={session} authFetch={authFetch} />}
    </TerminalActivationGate>
  )
}
