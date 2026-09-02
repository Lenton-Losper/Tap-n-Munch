'use client'

import { useEffect, useRef, useState } from 'react'
import { TerminalActivationGate } from '@/components/stations/terminal-activation-gate'
import { BarScreen } from '@/components/stations/bar-screen'
import { StationFaultNotice } from '@/components/stations/station-fault-notice'
import type { StationFault } from '@/lib/stations/faults'
import { StationLoading } from '@/components/stations/station-loading'
import { fetchInitialBarRounds } from '@/lib/stations/data-port'
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
import type { BarRound } from '@/lib/stations/types'
import type { AuthFetch, TerminalSession } from '@/lib/stations/use-terminal-session'

// Exported (not just used by BarPage below) so a test can mount the data-wired screen directly,
// with a fake session/authFetch — see KitchenScreenLive's identical note in app/kitchen/page.tsx.
export function BarScreenLive({ session, authFetch }: { session: TerminalSession; authFetch: AuthFetch }) {
  const [rounds, setRounds] = useState<BarRound[]>([])
  const [loading, setLoading] = useState(true)
  // One fault, not a set of booleans that can disagree with each other. See lib/stations/faults.ts.
  const [fault, setFault] = useState<StationFault | null>(null)
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

  useEffect(() => subscribeFeedConnectionState(() => setConnectionState(getFeedConnectionState())), [])

  // Same #350 pattern as orders-dashboard.tsx: ticks a clock only, never refetches.
  //
  // 1s, matching the kitchen board -- see its own comment. The board redesign gave the bar its
  // own active/ready escalation bands (barActiveEscalation, barReadyEscalation), so the "Bar has
  // no age escalation" this comment used to say is no longer true either way: both the escalation
  // bands and the visible MM:SS clock need second-resolution ticking now, not just the label.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [])

  // See app/kitchen/page.tsx's matching comment: last_seen_at only moves if something calls
  // this, and a paired-screens list that always reads "last seen: at activation" cannot tell a
  // week-long-healthy screen from one that has been dark for six days.
  useEffect(() => {
    const beat = () => void authFetch('/api/terminal/heartbeat', { method: 'POST' })
    beat()
    const id = window.setInterval(beat, 60_000)
    return () => window.clearInterval(id)
  }, [authFetch])

  useEffect(() => {
    let cancelled = false
    const channelKey = `station-bar:${session.terminalId}`

    const refetch = () => {
      void fetchInitialBarRounds(authFetch).then((snapshot) => {
        if (cancelled) return
        setRounds(snapshot.items)
        setFault(snapshot.fault)
        setPairedTo(snapshot.pairedTo)
        setLoading(false)
      })
    }

    refetchRef.current = refetch
    refetch()

    // See app/kitchen/page.tsx's matching comment: ruled reuse of
    // subscribeRestaurantOrdersRealtime, extended with onLineChange rather than forked.
    const unregister = registerFeedChannel(channelKey)
    const unsubscribe = subscribeRestaurantOrdersRealtime(session.restaurantId, {
      onLineChange: refetch,
      onStatus: (status) => {
        const { refetch: shouldRefetch } = reportFeedChannelStatus(channelKey, status)
        if (shouldRefetch) refetch()
      },
    })

    /**
     * See app/kitchen/page.tsx's matching comment and subscribeLineChanged's own docblock: the
     * postgres_changes subscription above is RLS-gated through auth.uid(), a station wall screen
     * is `anon`, and a denied Realtime subscription is silent rather than an error. This
     * restaurant-scoped Broadcast is the feed that actually reaches this screen, and it is
     * registered as its own feed channel so a broadcast that fails to join degrades the
     * connection indicator instead of hiding behind a channel that reports SUBSCRIBED while
     * delivering nothing.
     */
    const broadcastKey = `station-bar-broadcast:${session.terminalId}`
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
  if (fault) {
    return <StationFaultNotice fault={fault} pairedTo={pairedTo} station="bar" venueName={session.restaurantName} />
  }

  /**
   * The bar now bumps BY LINE ID, not by round id, so one drink can go out on its own and the
   * per-round control is a shortcut over the same call — see lib/stations/bump.ts.
   *
   * POST /api/terminal/bar-rounds/[roundId] still exists and still works; it is simply no longer
   * what this screen calls. It re-derives the set of lines server-side from the order, which is the
   * one thing the per-round control must not do: the card was painted from a snapshot, and a line
   * added since is a line nobody at the bar has seen.
   */
  return (
    <BarScreen
      venueName={session.restaurantName}
      rounds={rounds}
      now={nowMs}
      connectionState={connectionState}
      onBump={async (lineIds, action) => {
        const outcome = await postStationBump(authFetch, 'bar', lineIds, action)
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

export default function BarPage() {
  return (
    <TerminalActivationGate station="bar">
      {(session, authFetch) => <BarScreenLive session={session} authFetch={authFetch} />}
    </TerminalActivationGate>
  )
}
