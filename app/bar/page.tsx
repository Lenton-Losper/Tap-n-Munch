'use client'

import { useEffect, useState } from 'react'
import { TerminalActivationGate } from '@/components/stations/terminal-activation-gate'
import { BarScreen } from '@/components/stations/bar-screen'
import { StationNotEnabled } from '@/components/stations/station-not-enabled'
import { StationLoading } from '@/components/stations/station-loading'
import { fetchInitialBarRounds } from '@/lib/stations/data-port'
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
import type { BarRound } from '@/lib/stations/types'
import type { AuthFetch, TerminalSession } from '@/lib/stations/use-terminal-session'

function BarScreenLive({ session, authFetch }: { session: TerminalSession; authFetch: AuthFetch }) {
  const [rounds, setRounds] = useState<BarRound[]>([])
  const [loading, setLoading] = useState(true)
  const [notEnabled, setNotEnabled] = useState(false)
  const [notPaired, setNotPaired] = useState(false)
  const [pairedTo, setPairedTo] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<FeedConnectionState>(getFeedConnectionState())
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => subscribeFeedConnectionState(() => setConnectionState(getFeedConnectionState())), [])

  // Same #350 pattern as orders-dashboard.tsx: ticks a clock only, never refetches. Bar has no
  // age escalation, but the round age label ("in" vs "out") still needs a live `now`.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000)
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
        setNotEnabled(snapshot.notEnabled)
        setNotPaired(snapshot.notPaired)
        setPairedTo(snapshot.pairedTo)
        setLoading(false)
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
      rounds={rounds}
      now={nowMs}
      connectionState={connectionState}
      onBump={(lineIds, action) => postStationBump(authFetch, 'bar', lineIds, action)}
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
