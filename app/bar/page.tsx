'use client'

import { useEffect, useState } from 'react'
import { TerminalActivationGate } from '@/components/stations/terminal-activation-gate'
import { BarScreen } from '@/components/stations/bar-screen'
import { StationNotEnabled } from '@/components/stations/station-not-enabled'
import { fetchInitialBarRounds } from '@/lib/stations/data-port'
import { subscribeRestaurantOrdersRealtime } from '@/lib/supabase/orders'
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

function BarScreenLive({ session, authFetch }: { session: TerminalSession; authFetch: AuthFetch }) {
  const [rounds, setRounds] = useState<BarRound[]>([])
  const [notEnabled, setNotEnabled] = useState(false)
  const [connectionState, setConnectionState] = useState<FeedConnectionState>(getFeedConnectionState())
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => subscribeFeedConnectionState(() => setConnectionState(getFeedConnectionState())), [])

  // Same #350 pattern as orders-dashboard.tsx: ticks a clock only, never refetches. Bar has no
  // age escalation, but the round age label ("in" vs "out") still needs a live `now`.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    const channelKey = `station-bar:${session.terminalId}`

    const refetch = () => {
      void fetchInitialBarRounds(authFetch).then((snapshot) => {
        if (cancelled) return
        setRounds(snapshot.items)
        setNotEnabled(snapshot.notEnabled)
      })
    }

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
    <BarScreen
      rounds={rounds}
      now={nowMs}
      connectionState={connectionState}
      onBumpOut={(roundId) => {
        void authFetch(`/api/terminal/bar-rounds/${roundId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'out' }),
        })
      }}
    />
  )
}

export default function BarPage() {
  return (
    <TerminalActivationGate>
      {(session, authFetch) => <BarScreenLive session={session} authFetch={authFetch} />}
    </TerminalActivationGate>
  )
}
