'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import {
  fetchTabById,
  isTabSessionEndedStatus,
  type TabRow,
} from '@/lib/tab-session'
import { handleSessionExpired } from '@/lib/handle-session-expired'

type Options = {
  restaurantId: string
  tableNumber: number
  tabId: string | null
  tabStatus?: string | null
  enabled?: boolean
  onSessionEnded?: () => void
}

export function useTabSessionEndedRedirect({
  restaurantId,
  tableNumber,
  tabId,
  tabStatus,
  enabled = true,
  onSessionEnded,
}: Options) {
  const [redirecting, setRedirecting] = useState(false)
  const redirectedRef = useRef(false)

  const redirectToLanding = useCallback(() => {
    if (redirectedRef.current || !restaurantId) return
    redirectedRef.current = true
    setRedirecting(true)
    handleSessionExpired(restaurantId)
  }, [restaurantId])

  const evaluateTab = useCallback(
    (tab: TabRow | null) => {
      if (!tab || isTabSessionEndedStatus(tab.status)) {
        redirectToLanding()
      }
    },
    [redirectToLanding]
  )

  useEffect(() => {
    if (tabStatus && tabStatus !== 'ended' && tabStatus !== 'closed') return
    if (!enabled || !restaurantId || !tabId || redirectedRef.current) return

    let cancelled = false

    const load = async () => {
      try {
        const tab = await fetchTabById(tabId, restaurantId)
        if (!cancelled) evaluateTab(tab)
      } catch (error) {
        console.error('[TAB SESSION ENDED] initial tab check failed', error)
      }
    }

    void load()

    const channel = supabase
      .channel(`tab-session-ended-${tabId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tabs', filter: `id=eq.${tabId}` },
        () => {
          void fetchTabById(tabId, restaurantId)
            .then((tab) => {
              if (!cancelled) evaluateTab(tab)
            })
            .catch((error) => {
              console.error('[TAB SESSION ENDED] realtime tab check failed', error)
            })
        }
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [enabled, restaurantId, tabId, tabStatus, evaluateTab])

  return { redirecting }
}
