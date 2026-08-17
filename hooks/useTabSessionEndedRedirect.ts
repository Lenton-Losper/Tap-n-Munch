'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

    /**
     * The `tabs` subscription here never fired: `public.tabs` has never been in the
     * supabase_realtime publication (QRA-17). The mount-time `load()` above is what has always
     * been doing this hook's work, and it runs on every navigation into browse or cart.
     */

    return () => {
      cancelled = true
    }
  }, [enabled, restaurantId, tabId, tabStatus, evaluateTab])

  return { redirecting }
}
