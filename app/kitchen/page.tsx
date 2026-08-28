'use client'

import { useEffect, useState } from 'react'
import { TerminalActivationGate } from '@/components/stations/terminal-activation-gate'
import { KitchenScreen } from '@/components/stations/kitchen-screen'
import { StationNotEnabled } from '@/components/stations/station-not-enabled'
import { fetchInitialKitchenLines } from '@/lib/stations/data-port'
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
  const [notEnabled, setNotEnabled] = useState(false)
  const [connectionState, setConnectionState] = useState<FeedConnectionState>(getFeedConnectionState())

  useEffect(() => subscribeFeedConnectionState(() => setConnectionState(getFeedConnectionState())), [])

  useEffect(() => {
    let cancelled = false
    const channelKey = `station-kitchen:${session.terminalId}`

    const refetch = () => {
      void fetchInitialKitchenLines(authFetch).then((snapshot) => {
        if (cancelled) return
        setLines(snapshot.items)
        setNotEnabled(snapshot.notEnabled)
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

  if (notEnabled) {
    return <StationNotEnabled />
  }

  return (
    <KitchenScreen
      lines={lines}
      connectionState={connectionState}
      onMarkCooked={(lineId) => {
        void authFetch(`/api/terminal/station-lines/${lineId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cooked' }),
        })
      }}
      onMarkReadyToRun={(lineId) => {
        void authFetch(`/api/terminal/station-lines/${lineId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'ready_to_run' }),
        })
      }}
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
