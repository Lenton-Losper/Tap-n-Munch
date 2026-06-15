'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { useTab } from '@/contexts/tab-context'
import {
  fetchTabById,
  isTabSessionEndedStatus,
  landingPath,
  type TabRow,
} from '@/lib/tab-session'
import {
  clearTabSession,
  readStoredTableNumber,
  setSessionEndedNotice,
  clearActiveOrderBannerState,
} from '@/lib/tab-storage'

type Options = {
  restaurantId: string
  tableNumber: number
  tabId: string | null
  enabled?: boolean
  onSessionEnded?: () => void
}

export function useTabSessionEndedRedirect({
  restaurantId,
  tableNumber,
  tabId,
  enabled = true,
  onSessionEnded,
}: Options) {
  const router = useRouter()
  const { clearTab } = useTab()
  const [redirecting, setRedirecting] = useState(false)
  const redirectedRef = useRef(false)

  const redirectToLanding = useCallback(() => {
    if (redirectedRef.current || !restaurantId) return
    redirectedRef.current = true
    setRedirecting(true)
    setSessionEndedNotice()
    clearTabSession()
    clearActiveOrderBannerState()
    clearTab()
    onSessionEnded?.()

    const resolvedTable =
      tableNumber > 0 ? tableNumber : Number(readStoredTableNumber() || 0) || 0
    router.replace(landingPath(restaurantId, resolvedTable > 0 ? resolvedTable : ''))
  }, [restaurantId, tableNumber, clearTab, onSessionEnded, router])

  const evaluateTab = useCallback(
    (tab: TabRow | null) => {
      if (!tab || isTabSessionEndedStatus(tab.status)) {
        redirectToLanding()
      }
    },
    [redirectToLanding]
  )

  useEffect(() => {
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
  }, [enabled, restaurantId, tabId, evaluateTab])

  return { redirecting }
}
