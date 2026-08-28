'use client'

import { useEffect, useState } from 'react'
import { TerminalActivationGate } from '@/components/stations/terminal-activation-gate'
import { KitchenScreen } from '@/components/stations/kitchen-screen'
import { StationNotEnabled } from '@/components/stations/station-not-enabled'
import { StationLoading } from '@/components/stations/station-loading'
import { fetchInitialKitchenLines } from '@/lib/stations/data-port'
import { postStationBump } from '@/lib/stations/bump'
import { subscribeRestaurantOrdersRealtime } from '@/lib/supabase/orders'
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

function KitchenScreenLive({ session, authFetch }: { session: TerminalSession; authFetch: AuthFetch }) {
  const [lines, setLines] = useState<KitchenLine[]>([])
  const [loading, setLoading] = useState(true)
  const [notEnabled, setNotEnabled] = useState(false)
  const [notPaired, setNotPaired] = useState(false)
  const [pairedTo, setPairedTo] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<FeedConnectionState>(getFeedConnectionState())
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => subscribeFeedConnectionState(() => setConnectionState(getFeedConnectionState())), [])

  // Same #350 pattern as orders-dashboard.tsx: ticks a clock only, never refetches. 30s here
  // (tighter than the dashboard's 60s) because the ready-to-run escalation bands are what this
  // clock drives, and the red threshold sits at 5 minutes on a wall screen nobody refreshes.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000)
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
        setNotEnabled(snapshot.notEnabled)
        setNotPaired(snapshot.notPaired)
        setPairedTo(snapshot.pairedTo)
        setLoading(false)
      })
    }

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

    const stopFallback = startFeedFallback({ refetch })

    return () => {
      cancelled = true
      unregister()
      unsubscribe()
      stopFallback()
    }
  }, [session.restaurantId, session.terminalId, authFetch])

  if (loading) {
    return <StationLoading />
  }
  if (notPaired) {
    return <StationNotEnabled reason="not_paired" pairedTo={pairedTo} />
  }
  if (notEnabled) {
    return <StationNotEnabled />
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
      lines={lines}
      now={nowMs}
      connectionState={connectionState}
      onBump={(lineIds, action) => postStationBump(authFetch, 'kitchen', lineIds, action)}
    />
  )
}

export default function KitchenPage() {
  return (
    <TerminalActivationGate>
      {(session, authFetch) => <KitchenScreenLive session={session} authFetch={authFetch} />}
    </TerminalActivationGate>
  )
}
