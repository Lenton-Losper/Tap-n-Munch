// @ts-nocheck
'use client'

export const dynamic = "force-dynamic"

import { useEffect, useState, Suspense, useCallback } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/supabase/restaurants'
import { createFreshSession } from '@/lib/session'
import { ActiveOrderBanner } from '@/components/ActiveOrderBanner'
import OrderStatusBanner from '@/components/OrderStatusBanner'
import { Button } from '@/components/ui/button'
import { Receipt, ChevronRight, AlertTriangle } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { useCart } from '@/contexts/cart-context'
import { useTab } from '@/contexts/tab-context'
import { useRestaurant } from '@/contexts/restaurant-context'
import { supabase } from '@/lib/supabase/client'
import { fetchGuestActiveTableOrders } from '@/lib/guest-orders/client'
import { getSupabaseTableByNumber } from '@/lib/supabase/tables'
import { fetchTabById, isTabSessionEndedStatus } from '@/lib/tab-session'
import { isStoredTabAtAnotherTable } from '@/lib/tabs/landing-tab-actions'
import { shouldPromptForTabPin } from '@/lib/tabs/tab-action-refused'
import {
  clearTabSession,
  persistTabSession,
  readStoredTabId,
  consumeSessionEndedNotice,
  clearActiveOrderBannerState,
} from '@/lib/tab-storage'
import { handleSessionExpired } from '@/lib/handle-session-expired'
import { restaurantLogoDisplayUrl } from '@/lib/restaurant-logo'

function isTabPaymentInProgressError(message: string | null | undefined): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  return (
    lower.includes('ready_to_pay') ||
    lower.includes('payment is currently being processed') ||
    lower.includes('payment is being processed')
  )
}

function TabPaymentInProgressCard() {
  return (
    <div
      className="rounded-xl border border-amber-400/50 bg-amber-500/10 p-4 text-left flex items-start gap-3"
      role="status"
      aria-live="polite"
    >
      <AlertTriangle className="h-5 w-5 shrink-0 text-amber-300 mt-0.5" aria-hidden />
      <div>
        <p className="font-sans text-sm font-semibold text-amber-50">Payment in progress</p>
        <p className="font-sans text-xs text-amber-100/90 mt-1 leading-relaxed">
          A payment is currently being processed for this table. Please wait a moment until the
          payment is completed before joining the tab.
        </p>
      </div>
    </div>
  )
}

/**
 * #211 — copy for the "your tab is at a different table" case.
 *
 * Kept together and named so the wording is one decision in one place rather than string literals
 * buried in JSX. Customer-facing and set by the human; no behaviour depends on the wording.
 *
 * THE SUBTEXT IS NOT DECORATION. Both actions below replace the stored tab on this phone — the
 * previous tab stays open and settleable, but it leaves this device (same class as #220). Leaving
 * a tab with money on it is the one thing a customer is anxious about here, so the reassurance is
 * required, and it sits BENEATH the action rather than inside it: a button says what happens when
 * you tap it, the subtext answers "but what about my bill?".
 *
 * If this is ever moved somewhere a second line genuinely cannot render, fold the clause into the
 * label ("Start a new tab at Table 7 — your Table 3 tab stays open") rather than dropping it.
 * Ruled 2026-08-12: the clause is the part that matters.
 */
const TAB_ELSEWHERE_COPY = {
  /** Heading on the rejoin card when the stored tab belongs to another table. */
  heading: (tabTable: number) => `Your tab is open at Table ${tabTable}`,
  /** Secondary action when the SCANNED table has no open tab of its own. */
  startHere: (scannedTable: number) => `Start a new tab at Table ${scannedTable}`,
  /** Secondary action when the SCANNED table already has an open tab. PIN-gated. */
  joinHere: (scannedTable: number) => `Join the tab at Table ${scannedTable}`,
  /** Reassurance beneath either action. Names the table the EXISTING tab belongs to. */
  staysOpen: (tabTable: number) => `Your Table ${tabTable} tab stays open`,
} as const

export type MenuLandingPageV2ContentProps = {
  restaurantIdOverride?: string
  tableNumberOverride?: number
}

export function MenuLandingPageV2Content({
  restaurantIdOverride,
  tableNumberOverride,
}: MenuLandingPageV2ContentProps = {}) {
  console.log("🚀 [SYSTEM LIVE] Luxury Theme - Landing Page v3.0")
  
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId =
    restaurantIdOverride ?? (params?.restaurantId as string | undefined)
  const tableNumberParam = searchParams?.get('table')
  const tableNum =
    tableNumberOverride ??
    (tableNumberParam ? Number(tableNumberParam) : 0)
  
  const [restaurant, setRestaurant] = useState<any>(null)
  const [table, setTable] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [sessionId, setSessionId] = useState<string>('')
  const [sessionReady, setSessionReady] = useState(false)
  const [isViewOnlyTable, setIsViewOnlyTable] = useState(false)
  // Distinct from `loading`: `loading` flips false as soon as the restaurant fetch
  // resolves, which happens before this table lookup (and therefore isViewOnlyTable) is
  // known -- gating on `loading` alone still leaves the same race window open.
  const [tableFetchDone, setTableFetchDone] = useState(false)
  const [openTab, setOpenTab] = useState<{
    id: string
    total: number
    members: number
    pin_required: boolean
    status: string
  } | null>(null)
  // #211: `tableNumber` is the table the stored tab actually BELONGS to, which is not necessarily
  // the table that was just scanned. Without it the landing cannot tell "you are back at your own
  // table" from "you have walked to a different one", and it offered "Rejoin your tab" for both.
  // The value costs nothing to carry: fetchTabById already selects table_number and threw it away.
  const [myStoredTab, setMyStoredTab] = useState<
    { id: string; total: number; status: string; tableNumber: number | null } | null
  >(null)
  const [storedTabChecked, setStoredTabChecked] = useState(false)
  const [tabLoading, setTabLoading] = useState(false)
  const [tabActionLoading, setTabActionLoading] = useState<'create' | 'join' | null>(null)
  const [tabActionError, setTabActionError] = useState<string | null>(null)
  const [recentHostedPending, setRecentHostedPending] = useState<{ id: string; placed_at: string } | null>(
    null
  )
  const [sessionEndedNotice, setSessionEndedNotice] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [displayNameError, setDisplayNameError] = useState('')
  const [createdTabPin, setCreatedTabPin] = useState<{ tabId: string; pin: string } | null>(null)
  const [showJoinPinEntry, setShowJoinPinEntry] = useState(false)
  const [joinPin, setJoinPin] = useState('')
  const [joinPinError, setJoinPinError] = useState<string | null>(null)
  const { clearCart } = useCart()
  const { createNewTab, joinExistingTab, joinTabWithPin, clearTab } = useTab()
  const { currency } = useRestaurant()

  useEffect(() => {
    console.log('[V2] page mounted, URL:', window.location.href)
    console.log('[V2] token at mount:', localStorage.getItem('flashtap_session_token'))
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (sessionStorage.getItem('flashtap_session_expired') === 'true') {
      window.location.replace(
        window.location.hostname !== 'flashtap.app' &&
        !window.location.hostname.includes('localhost') &&
        !window.location.hostname.includes('vercel.app')
          ? '/session-ended'
          : `/menu/${restaurantId}/session-ended`
      )
      return
    }
  }, [restaurantId])

  useEffect(() => {
    if (consumeSessionEndedNotice()) {
      clearActiveOrderBannerState()
      clearTab()
      clearCart()
      if (restaurantId) handleSessionExpired(String(restaurantId))
    }
  }, [clearTab, clearCart, restaurantId])

  useEffect(() => {
    if (sessionEndedNotice && restaurantId) {
      handleSessionExpired(String(restaurantId))
    }
  }, [sessionEndedNotice, restaurantId])

  // Load restaurant data
  /* eslint-disable react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope */
  useEffect(() => {
    if (!restaurantId) {
      setError('Restaurant ID is missing from URL')
      setLoading(false)
      return
    }
    getRestaurant(restaurantId)
      .then((data) => {
        setRestaurant(data)
        setLoading(false)
      })
      .catch(() => {
        setError('Please scan a valid QR code to access this restaurant menu.')
        setLoading(false)
      })
  }, [restaurantId])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Table fetch
  /* eslint-disable react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope */
  useEffect(() => {
    if (!restaurant || !restaurantId) return
    if (tableNum <= 0) {
      setLoading(false)
      setError(null)
      setTableFetchDone(true)
      return
    }

    const loadTableData = async () => {
      try {
        const tableData = await getSupabaseTableByNumber(
          restaurantId,
          tableNum,
          false
        ).catch((err) => {
          console.warn('[V2] table lookup failed', err)
          return null
        })

        if (!tableData) {
          setTable(null)
          setLoading(false)
          setError('This table is not available for ordering.')
          setTableFetchDone(true)
          return
        }

        console.log('[V2] table state', {
          table: tableData.table_number,
          status: tableData.status,
          version: tableData.current_session_version,
        })

        // Read the session version the customer was issued
        const storedToken = sessionStorage.getItem('flashtap_session_token')
        const storedTabId = localStorage.getItem('flashtap_tab_id')

        // If customer has an existing session token, validate version before proceeding
        if (storedToken && storedTabId) {
          // Validate via server
          const guardRes = await fetch('/api/session/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: storedToken }),
          }).catch(() => null)

          if (guardRes?.status === 410) {
            console.log('[V2] session invalid — redirecting to session-ended')
            handleSessionExpired(restaurantId)
            return
          }
        }

        // No existing session — check table status before creating fresh session
        // Only create a fresh session if table is in a clean available state
        // If table was recently closed (status = 'available' but version > 1 means
        // it has been used before — still ok for new customers)
        // Never create a session if table status indicates it was just closed
        // and the close happened after the customer loaded the page
        setTable(tableData)

        if ((tableData as { is_view_only?: boolean }).is_view_only) {
          // Menu-only ordering point: never create a tab session, and scrub any tab/cart
          // state the browser happens to be carrying from a previous visit to a real
          // table -- a view-only QR must render clean regardless of stale localStorage.
          setIsViewOnlyTable(true)
          clearTabSession()
          clearActiveOrderBannerState()
          clearTab()
          clearCart()
          setLoading(false)
          setError(null)
          setTableFetchDone(true)
          return
        }

        const session = createFreshSession(restaurantId, String(tableNum))
        if (session) {
          setSessionId(session)
          setSessionReady(true)
          if (typeof window !== 'undefined') {
            localStorage.setItem('current_restaurant_id', restaurantId)
          }
          clearCart()
        }
      } catch (err: any) {
        setTable(null)
      }

      setLoading(false)
      setError(null)
      setTableFetchDone(true)
    }

    loadTableData()
    // clearCart is not memoized in cart context; omit to avoid re-running table load every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run only when restaurant/table identity changes
  }, [restaurant, restaurantId, tableNum])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Loading timeout
  useEffect(() => {
    if (loading) {
      const timeoutId = setTimeout(() => {
        if (loading && !restaurant) {
          setError('Loading took too long. Please scan a valid QR code or refresh the page.')
          setLoading(false)
        }
      }, 5000)
      return () => clearTimeout(timeoutId)
    }
  }, [loading, restaurant])

  const endTabSession = useCallback(
    (showNotice: boolean) => {
      clearTabSession()
      clearActiveOrderBannerState()
      clearTab()
      clearCart()
      setMyStoredTab(null)
      setOpenTab(null)
      if (showNotice) {
        setSessionEndedNotice(true)
      }
    },
    [clearTab, clearCart]
  )

  const syncTabLandingState = useCallback(async () => {
    if (isViewOnlyTable) {
      // No tab/session concept applies to a view-only ordering point -- skip every
      // tab-related lookup below rather than have it race with the clear performed
      // when the table was first resolved as view-only.
      setMyStoredTab(null)
      setOpenTab(null)
      setStoredTabChecked(true)
      return
    }
    // Check if token is invalid before showing landing UI
    const storedToken = localStorage.getItem('flashtap_session_token') ||
                        sessionStorage.getItem('flashtap_session_token')

    if (storedToken) {
      const res = await fetch('/api/session/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: storedToken }),
      }).catch(() => null)

      if (res?.status === 410) {
        // Token is invalid — clear everything and show session ended
        sessionStorage.removeItem('flashtap_session_token')
        localStorage.removeItem('flashtap_session_token')
        localStorage.removeItem('flashtap_tab_id')
        localStorage.removeItem('flashtap_table')
        window.location.replace(`/menu/${restaurantId}/session-ended`)
        return
      }
    }

    if (!restaurantId || tableNum <= 0) {
      setMyStoredTab(null)
      setOpenTab(null)
      setStoredTabChecked(true)
      return
    }

    const restaurantUuid = String(restaurant?.id || restaurantId || '')
    const storedId = readStoredTabId()

    if (storedId) {
      try {
        const tab = await fetchTabById(storedId, restaurantUuid)
        if (!tab || isTabSessionEndedStatus(tab.status)) {
          endTabSession(true)
          setStoredTabChecked(true)
          return
        }
      } catch (err) {
        console.warn('[V2] stored tab validation failed', err)
      }
    }

    // #211: captured locally rather than read back off `myStoredTab`, because a setState is not
    // visible to the rest of this same pass and the open-tab decision below is made in it.
    let storedTabTable: number | null = null

    if (!storedId) {
      setMyStoredTab(null)
      const { count: openOrdersCount } = await fetchGuestActiveTableOrders({
        restaurantId: restaurantUuid,
        tableNumber: tableNum,
        countOnly: true,
      })
      if ((openOrdersCount || 0) === 0) {
        clearActiveOrderBannerState()
      }
    } else {
      try {
        const tab = await fetchTabById(storedId, restaurantUuid)
        const tabStatus = String(tab?.status || '').toLowerCase()

        if (!tab || isTabSessionEndedStatus(tab.status)) {
          endTabSession(Boolean(storedId))
        } else if (tabStatus === 'open') {
          const { data: openTabRow, error: openTabValidateError } = await supabase
            .from('tabs')
            .select('id, total, status')
            .eq('id', storedId)
            .eq('restaurant_id', restaurantUuid)
            .eq('status', 'open')
            .maybeSingle()

          if (openTabValidateError) {
            throw openTabValidateError
          }

          if (openTabRow) {
            // #211/#221: persist the tab's OWN table, never the scanned one. This used to write
            // `tableNum`, so walking to another table silently re-pointed the stored tab at
            // wherever you last scanned -- which destroys the comparison below on the next load
            // and is why the mismatch was invisible.
            storedTabTable = tab?.table_number == null ? null : Number(tab.table_number)
            persistTabSession(storedId, storedTabTable ?? tableNum)
            setMyStoredTab({
              id: String(openTabRow.id),
              total: Number(openTabRow.total) || 0,
              status: 'open',
              tableNumber: storedTabTable,
            })
          } else {
            clearTabSession()
            setMyStoredTab(null)
          }
        } else {
          clearTabSession()
          setMyStoredTab(null)
        }
      } catch (err) {
        console.warn('[V2] stored tab validation failed', err)
        endTabSession(Boolean(storedId))
      }
    }

    setStoredTabChecked(true)

    // #211: this used to blind the screen unconditionally whenever a tab was stored, so the
    // scanned table's own tab was never looked up and the "a tab is already open for this table"
    // branch below was unreachable for exactly the customers who had walked to a different table.
    //
    // It is still skipped when the stored tab IS this table's -- there is nothing to compare and
    // the rejoin card is the whole answer. It is only performed when the tables differ, because
    // then the customer needs to know what is waiting HERE before choosing.
    const storedTabIdNow = readStoredTabId()
    const storedTabIsElsewhere =
      Boolean(storedTabIdNow) && isStoredTabAtAnotherTable(storedTabTable, tableNum)
    if (storedTabIdNow && !storedTabIsElsewhere) {
      setOpenTab(null)
      return
    }

    try {
      setTabLoading(true)
      // #262: this ran as an anon `select ... members ...` on `tabs`, and the anon grant that
      // permits it has no restaurant scope -- the same key could list every diner's session_id
      // on every open tab in every restaurant. This screen only needs the member COUNT, so the
      // whole lookup (12-hour cutoff, table_id/table_number branch and all) now happens
      // server-side as service_role and comes back with `member_count` instead of `members`.
      const params = new URLSearchParams({
        restaurantId: restaurantUuid,
        tableNumber: String(tableNum),
      })
      const tabRes = await fetch(`/api/tabs/active?${params.toString()}`, { cache: 'no-store' })
      const tabPayload = (await tabRes.json().catch(() => ({}))) as {
        tab?: {
          id?: unknown
          status?: unknown
          total?: unknown
          pin_required?: unknown
          member_count?: unknown
        } | null
        error?: unknown
      }
      if (!tabRes.ok) {
        console.error('[TAB CHECK] query error:', tabPayload?.error || tabRes.status)
      }

      const tabData = tabPayload?.tab

      if (!tabData) {
        setOpenTab(null)
        return
      }

      setOpenTab({
        id: String(tabData.id),
        total: Number(tabData.total) || 0,
        members: Number(tabData.member_count) || 0,
        pin_required: tabData.pin_required !== false,
        status: String(tabData.status || 'open'),
      })
    } catch (tabErr) {
      console.error('Failed to load open tab:', tabErr)
      setOpenTab(null)
    } finally {
      setTabLoading(false)
    }
    // `table` is no longer read here: /api/tabs/active resolves the table row itself. The
    // realtime effect below still depends on `table?.id` directly, and the effect that calls
    // this one is gated on `tableFetchDone`, which flips in the same batch as setTable.
  }, [restaurantId, restaurant?.id, tableNum, endTabSession, isViewOnlyTable])

  useEffect(() => {
    // Wait for the table fetch (and therefore isViewOnlyTable) to resolve first -- NOT
    // `loading`, which flips false as soon as the restaurant fetch resolves, before the
    // table lookup even starts. Without this gate, this effect and the table-fetch effect
    // both kick off async work on mount independently -- syncTabLandingState's own
    // isViewOnlyTable check reads a value that's still `false` (not yet resolved) on that
    // first pass, so it can find a stale/nonexistent stored tab id, treat it as a
    // genuinely ended session, and fire handleSessionExpired's hard redirect before the
    // view-only table is ever detected.
    if (!tableFetchDone) return
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await syncTabLandingState()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [syncTabLandingState, tableFetchDone])

  useEffect(() => {
    if (!restaurantId || tableNum <= 0) return

    const restaurantUuid = String(restaurant?.id || restaurantId || '')
    const storedId = readStoredTabId()

    const onTabChange = () => {
      void syncTabLandingState()
    }

    const channels: ReturnType<typeof supabase.channel>[] = []

    if (storedId) {
      channels.push(
        supabase
          .channel(`v2-stored-tab-${storedId}`)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'tabs', filter: `id=eq.${storedId}` },
            onTabChange
          )
          .subscribe()
      )
    }

    if (table?.id) {
      channels.push(
        supabase
          .channel(`v2-table-row-${table.id}`)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'restaurant_tables', filter: `id=eq.${table.id}` },
            onTabChange
          )
          .subscribe()
      )
    }

    channels.push(
      supabase
        .channel(`v2-restaurant-tabs-${restaurantUuid}-${tableNum}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'tabs', filter: `restaurant_id=eq.${restaurantUuid}` },
          (payload) => {
            const row = (payload.new || payload.old) as Record<string, unknown> | null
            if (!row) return
            const rowTableNum = Number(row.table_number || 0)
            const rowTableId = String(row.table_id || '')
            if (rowTableNum === tableNum || (table?.id && rowTableId === String(table.id))) {
              onTabChange()
            }
          }
        )
        .subscribe()
    )

    const onFocus = () => {
      void syncTabLandingState()
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus)
    }

    return () => {
      channels.forEach((channel) => supabase.removeChannel(channel))
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus)
      }
    }
  }, [restaurantId, restaurant?.id, tableNum, table?.id, syncTabLandingState, myStoredTab?.id])

  const canTrackHostedPending = Boolean(restaurantId && tableNum > 0)
  const hostedPendingKey = `${restaurantId}|${tableNum}`
  const [hostedPendingScopeKey, setHostedPendingScopeKey] = useState(hostedPendingKey)
  if (hostedPendingScopeKey !== hostedPendingKey) {
    setHostedPendingScopeKey(hostedPendingKey)
    setRecentHostedPending(null)
  }

  useEffect(() => {
    if (!canTrackHostedPending) return
    let cancelled = false
    const run = async () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
      const { count: abandonedCount } = await fetchGuestActiveTableOrders({
        restaurantId,
        tableNumber: tableNum,
        paymentStatus: 'pending',
        paymentChannel: 'hosted',
        placedBefore: tenMinutesAgo,
        countOnly: true,
      })

      if (!cancelled && (abandonedCount || 0) > 0) {
        try {
          await fetch('/api/orders/expire-pending', { method: 'POST' })
        } catch (e) {
          console.warn('[TABLE] expire-pending failed', e)
        }
      }

      const { orders: recentPending } = await fetchGuestActiveTableOrders({
        restaurantId,
        tableNumber: tableNum,
        paymentStatus: 'pending',
        paymentChannel: 'hosted',
        placedAfter: tenMinutesAgo,
      })

      if (cancelled) return
      const row = recentPending?.[0]
      setRecentHostedPending(
        row ? { id: String(row.id), placed_at: String(row.placed_at || '') } : null
      )
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [canTrackHostedPending, restaurantId, tableNum])

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const minutesSince = (iso: string) => {
    const t = new Date(iso).getTime()
    if (Number.isNaN(t)) return 0
    return Math.floor((nowMs - t) / 60_000)
  }

  const blockOrderingForHostedPending = Boolean(
    recentHostedPending && minutesSince(recentHostedPending.placed_at) < 10
  )

  const browseBase = `/menu/${restaurantId}/browse${tableNum > 0 ? `?table=${tableNum}` : ''}`
  const browseWithTab = (tid: string) =>
    `${browseBase}${browseBase.includes('?') ? '&' : '?'}tabId=${encodeURIComponent(tid)}`

  const handleViewMenu = () => {
    console.log('[V2] view menu without joining tab')
    clearTab()
    router.push(browseBase)
  }

  const persistDisplayName = () => {
    if (typeof window === 'undefined') return
    if (displayName.trim()) {
      sessionStorage.setItem('flashtap_display_name', displayName.trim())
    }
  }

  const requireDisplayName = (): boolean => {
    if (!displayName.trim()) {
      setDisplayNameError('Please enter your name')
      return false
    }
    setDisplayNameError('')
    return true
  }

  const handleCreateTab = async () => {
    if (!requireDisplayName()) return
    if (!restaurantId || tableNum <= 0) {
      setTabActionError('Missing restaurant or table number. Scan the table QR code again.')
      console.error('[V2] create tab blocked — missing restaurantId or tableNum', { restaurantId, tableNum })
      return
    }
    try {
      setTabActionLoading('create')
      setTabActionError(null)
      persistDisplayName()
      console.log('[V2] create tab clicked', { restaurantId, tableNum, tableId: table?.id })
      const result = await createNewTab({
        restaurantId,
        tableNumber: String(tableNum),
        tableId: table?.id ? String(table.id) : undefined,
        displayName: displayName.trim() || undefined,
      })
      console.log('[V2] create tab success', result)
      if (result.tabPin) {
        if (typeof window !== 'undefined') {
          sessionStorage.setItem('flashtap_creator_tab_pin', result.tabPin)
          sessionStorage.setItem('flashtap_creator_tab_id', result.tabId)
        }
        setCreatedTabPin({ tabId: result.tabId, pin: result.tabPin })
        return
      }
      router.push(browseWithTab(result.tabId))
    } catch (err) {
      console.error('[V2] create tab failed:', err)
      /**
       * The table already has an open tab and it is PIN-gated (QRA-02/03).
       *
       * Before this, the customer got the sentence in `tabActionError` and nothing to press. The
       * landing only renders a Join affordance when GET /api/tabs/active returned a tab, and the
       * two ways to reach Create on an occupied table are exactly the two where it did not: the
       * genuine create race, and a tab older than the landing's 12-hour window (#218). So the
       * cases that produce this refusal are precisely the cases with no visible way forward.
       *
       * Route it into the PIN prompt that already exists instead. The tab that refused us is the
       * open tab AT THIS TABLE, and handleSubmitJoinPin on this branch joins unconditionally via
       * joinTabWithPin — by table number — which is exactly that tab.
       *
       * NO setPinTarget HERE, and the difference from cloudflare-staging is deliberate. Staging
       * carries #211's `pinTarget` state to choose between the scanned table and a stored tab at
       * another table; that state does not exist on this branch, so the staging version of this
       * block would throw a ReferenceError the moment a customer hit the refusal. `@ts-nocheck`
       * at the top of this file means the compiler cannot see it either. When #211 is promoted,
       * add `setPinTarget('scanned-table')` back — the target is the scanned table either way.
       *
       * TAB_ALREADY_OPEN is deliberately not handled here: it means the open tab has no PIN, so
       * there is nothing to prompt for and its copy sends the customer to staff.
       */
      if (shouldPromptForTabPin(err)) {
        setTabActionError(null)
        setJoinPin('')
        setJoinPinError(err.message)
        setShowJoinPinEntry(true)
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to create tab. Please try again.'
      setTabActionError(message)
    } finally {
      setTabActionLoading(null)
    }
  }

  /**
   * #211: the stored tab belongs to a table other than the one just scanned.
   *
   * Null-safe on purpose. A tab whose `table_number` we do not know is treated as "not
   * elsewhere", so the screen falls back to today's behaviour rather than inventing a mismatch
   * from missing data.
   */
  const storedTabIsAtAnotherTable = isStoredTabAtAnotherTable(myStoredTab?.tableNumber, tableNum)

  const handleContinueAfterPin = () => {
    if (!createdTabPin) return
    router.push(browseWithTab(createdTabPin.tabId))
    setCreatedTabPin(null)
  }

  /**
   * #211: join the tab belonging to the table that was just SCANNED, even though this customer
   * already holds a tab elsewhere.
   *
   * Deliberately not `handleStartJoinTab`, which short-circuits to the stored tab whenever one
   * exists -- correct for every other caller and exactly wrong here, because the whole point of
   * this action is that the two tables differ.
   *
   * It routes through the PIN entry (or the no-PIN join) like any other join, so it reaches
   * `POST /api/tabs/[tabId]/join`, which enforces the PIN unconditionally since #262's
   * containment. It must never fall through to `handleCreateTab`: creating against a table that
   * already has an open tab hits `idx_tabs_one_open_per_table`, and `POST /api/tabs`'s 23505
   * recovery branch still performs a PIN-less join (#218, open).
   */
  const handleJoinTabAtThisTable = () => {
    if (openTab?.pin_required === false) {
      void handleJoinWithoutPin()
      return
    }
    setJoinPin('')
    setJoinPinError(null)
    setShowJoinPinEntry(true)
  }

  const handleStartJoinTab = () => {
    if (myStoredTab) {
      void handleRejoinStoredTab()
      return
    }
    if (openTab?.pin_required === false) {
      void handleJoinWithoutPin()
      return
    }
    setJoinPin('')
    setJoinPinError(null)
    setShowJoinPinEntry(true)
  }

  const handleJoinWithoutPin = async () => {
    if (!requireDisplayName()) return
    if (!restaurantId || !openTab?.id) {
      setTabActionError('No open tab found to join.')
      return
    }
    try {
      setTabActionLoading('join')
      setTabActionError(null)
      persistDisplayName()
      await joinExistingTab({
        restaurantId,
        tabId: openTab.id,
        tableNumber: tableNum,
        displayName: displayName.trim() || undefined,
      })
      router.push(browseWithTab(openTab.id))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to join tab. Please try again.'
      console.error('[V2] join tab without PIN failed:', err)
      setTabActionError(message)
    } finally {
      setTabActionLoading(null)
    }
  }

  const handleRejoinStoredTab = async () => {
    if (!requireDisplayName()) return
    const joinTabId = myStoredTab?.id
    if (!restaurantId || !joinTabId) {
      setTabActionError('No open tab found to join.')
      return
    }
    try {
      setTabActionLoading('join')
      setTabActionError(null)
      persistDisplayName()
      await joinExistingTab({
        restaurantId,
        tabId: joinTabId,
        tableNumber: tableNum,
        displayName: displayName.trim() || undefined,
      })
      router.push(browseWithTab(joinTabId))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to join tab. Please try again.'
      console.error('[V2] rejoin tab failed:', err)
      setTabActionError(message)
    } finally {
      setTabActionLoading(null)
    }
  }

  const handleSubmitJoinPin = async () => {
    if (!requireDisplayName()) return
    if (!restaurantId || tableNum <= 0) {
      setJoinPinError('Missing restaurant or table number.')
      return
    }
    if (!/^\d{4}$/.test(joinPin.trim())) {
      setJoinPinError('Enter the 4-digit PIN.')
      return
    }
    try {
      setTabActionLoading('join')
      setJoinPinError(null)
      persistDisplayName()
      const joinedTabId = await joinTabWithPin({
        restaurantId,
        tableNumber: tableNum,
        pin: joinPin.trim(),
        displayName: displayName.trim() || undefined,
      })
      setShowJoinPinEntry(false)
      setJoinPin('')
      router.push(browseWithTab(joinedTabId))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to join tab. Please try again.'
      setJoinPinError(message)
    } finally {
      setTabActionLoading(null)
    }
  }

  const handleJoinTab = async () => {
    if (myStoredTab) {
      await handleRejoinStoredTab()
      return
    }
    handleStartJoinTab()
  }

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-2 border-white/30 border-t-white animate-spin mx-auto" />
          <p className="mt-6 text-white/60 font-sans text-sm tracking-wide">Loading...</p>
        </div>
      </div>
    )
  }

  // Error states
  if (error && !restaurant) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-serif font-bold text-white mb-4">Access Denied</h1>
          <p className="text-white/60 font-sans mb-6">{error}</p>
          <Button
            onClick={() => window.location.reload()}
            className="bg-white text-[#0A0A0A] hover:bg-white/90 font-sans px-8 py-3"
          >
            Retry
          </Button>
        </div>
      </div>
    )
  }

  if (!restaurant && !loading) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-serif font-bold text-white mb-4">Restaurant Not Found</h1>
          <p className="text-white/60 font-sans">Please scan a valid QR code.</p>
        </div>
      </div>
    )
  }
  
  if (!restaurantId) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-serif font-bold text-white mb-4">Error</h1>
          <p className="text-white/60 font-sans">Restaurant ID is missing from URL</p>
        </div>
      </div>
    )
  }

  // View-only ordering point: menu only, full stop. No tab UI, no display-name entry, no
  // receipt link -- there is nothing here that could lead to an order, unlike the regular
  // landing page which always renders some path toward starting/joining a tab.
  if (isViewOnlyTable) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-black/80 z-10" />
          {restaurant.hero_image_url && (
            <Image src={restaurant.hero_image_url} alt="" fill className="object-cover" priority />
          )}
          <div className="absolute inset-0 bg-gradient-to-br from-[#0A0A0A] via-[#1A1A1A] to-[#0A0A0A]" />
        </div>
        <div className="relative z-20 flex flex-col items-center justify-center min-h-screen px-6 py-12">
          <div className="w-full max-w-md text-center space-y-8">
            <div className="flex justify-center mb-8">
              {restaurantLogoDisplayUrl(restaurantId, restaurant.logo_url) ? (
                <div className="w-28 h-28 border-2 border-white/20 overflow-hidden bg-white/10 backdrop-blur-sm">
                  <Image
                    src={restaurantLogoDisplayUrl(restaurantId, restaurant.logo_url)!}
                    alt={restaurant.name}
                    width={112}
                    height={112}
                    className="object-cover w-full h-full"
                    priority
                  />
                </div>
              ) : (
                <div className="w-28 h-28 border-2 border-white/20 flex items-center justify-center bg-white/10 backdrop-blur-sm">
                  <span className="text-5xl font-serif font-bold text-white">
                    {restaurant.name?.charAt(0) || 'R'}
                  </span>
                </div>
              )}
            </div>
            <div className="space-y-4">
              <p className="text-white/60 font-sans text-sm uppercase tracking-[0.3em]">Welcome to</p>
              <h1 className="text-5xl md:text-6xl font-serif font-bold text-white tracking-tight leading-tight">
                {restaurant?.name || 'Restaurant'}
              </h1>
              {restaurant.description && (
                <p className="text-white/50 font-sans text-base max-w-xs mx-auto leading-relaxed">
                  {restaurant.description}
                </p>
              )}
            </div>
            <div className="pt-8">
              <Link href={browseBase} className="block">
                <Button
                  size="lg"
                  className="w-full bg-white text-[#0A0A0A] hover:bg-white/90 text-base font-semibold py-6 font-sans group"
                >
                  View Menu
                  <ChevronRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform stroke-[2]" />
                </Button>
              </Link>
            </div>
            <div className="pt-12">
              <p className="text-white/20 font-sans text-xs tracking-wide">Powered by FlashTap</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A] relative overflow-hidden">
      <OrderStatusBanner restaurantId={restaurantId} tableNumber={tableNum} />
      {/* Active Order Banner */}
      <ActiveOrderBanner />
      
      {/* Hero Background - Dark moody overlay */}
      <div className="absolute inset-0">
        {/* Dark gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-black/80 z-10" />
        
        {/* Optional: Background image if restaurant has one */}
        {restaurant.hero_image_url && (
          <Image
            src={restaurant.hero_image_url}
            alt=""
            fill
            className="object-cover"
            priority
          />
        )}
        
        {/* Fallback gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#0A0A0A] via-[#1A1A1A] to-[#0A0A0A]" />
      </div>
      
      {/* Main Content */}
      <div className="relative z-20 flex flex-col items-center justify-center min-h-screen px-6 py-12">
        <div className="w-full max-w-md text-center space-y-8">
          
          {/* Restaurant Logo */}
          <div className="flex justify-center mb-8">
            {restaurantLogoDisplayUrl(restaurantId, restaurant.logo_url) ? (
              <div className="w-28 h-28 border-2 border-white/20 overflow-hidden bg-white/10 backdrop-blur-sm">
                <Image
                  src={restaurantLogoDisplayUrl(restaurantId, restaurant.logo_url)!}
                  alt={restaurant.name}
                  width={112}
                  height={112}
                  className="object-cover w-full h-full"
                  priority
                />
              </div>
            ) : (
              <div className="w-28 h-28 border-2 border-white/20 flex items-center justify-center bg-white/10 backdrop-blur-sm">
                <span className="text-5xl font-serif font-bold text-white">
                  {restaurant.name?.charAt(0) || 'R'}
                </span>
              </div>
            )}
          </div>

          {/* Welcome Text */}
          <div className="space-y-4">
            <p className="text-white/60 font-sans text-sm uppercase tracking-[0.3em]">
              Welcome to
            </p>
            <h1 className="text-5xl md:text-6xl font-serif font-bold text-white tracking-tight leading-tight">
              {restaurant?.name || 'Restaurant'}
            </h1>
            {restaurant.description && (
              <p className="text-white/50 font-sans text-base max-w-xs mx-auto leading-relaxed">
                {restaurant.description}
              </p>
            )}
          </div>

          {/* Table Indicator */}
          {tableNum > 0 && (
            <div className="pt-4">
              <p className="text-white/40 font-sans text-xs uppercase tracking-[0.2em]">
                Table {tableNum}
              </p>
            </div>
          )}

          {/* CTA Buttons */}
          <div className="space-y-4 pt-8">
            {createdTabPin ? (
              <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-6 text-center space-y-4">
                <div>
                  <p className="font-sans text-lg font-semibold text-white">Your tab PIN is</p>
                  <p className="font-mono text-5xl font-bold tracking-[0.3em] text-white mt-4">
                    {createdTabPin.pin}
                  </p>
                  <p className="font-sans text-sm text-white/80 mt-4">
                    Share this with your group so they can join your tab.
                  </p>
                </div>
                <Button
                  size="lg"
                  onClick={handleContinueAfterPin}
                  className="w-full bg-white text-[#0A0A0A] hover:bg-white/90 text-base font-semibold py-6 font-sans"
                >
                  Continue
                </Button>
              </div>
            ) : showJoinPinEntry ? (
              <div className="rounded-xl border border-white/25 bg-white/10 p-6 text-center space-y-4">
                <div>
                  <p className="font-sans text-lg font-semibold text-white">Enter tab PIN</p>
                  <p className="font-sans text-sm text-white/70 mt-2">
                    Ask the person who created the tab for the 4-digit PIN.
                  </p>
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={4}
                  placeholder="0000"
                  value={joinPin}
                  onChange={(e) => {
                    setJoinPin(e.target.value.replace(/\D/g, '').slice(0, 4))
                    setJoinPinError(null)
                  }}
                  className="w-full rounded-lg border border-white/20 bg-white/10 px-4 py-4 text-center text-white text-3xl font-mono tracking-[0.4em] placeholder-white/30 focus:outline-none focus:border-white/40"
                />
                {joinPinError && isTabPaymentInProgressError(joinPinError) ? (
                  <TabPaymentInProgressCard />
                ) : joinPinError ? (
                  <p className="font-sans text-sm text-red-200">{joinPinError}</p>
                ) : null}
                <Button
                  size="lg"
                  onClick={handleSubmitJoinPin}
                  disabled={tabActionLoading !== null || joinPin.length !== 4}
                  className="w-full bg-white text-[#0A0A0A] hover:bg-white/90 text-base font-semibold py-6 font-sans"
                >
                  {tabActionLoading === 'join' ? 'Joining tab…' : 'Join Tab'}
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => {
                    setShowJoinPinEntry(false)
                    setJoinPin('')
                    setJoinPinError(null)
                  }}
                  disabled={tabActionLoading !== null}
                  className="w-full border-2 border-white/40 bg-transparent text-white hover:bg-white/10 hover:border-white/60 text-base py-6 font-sans"
                >
                  Back
                </Button>
              </div>
            ) : (
              <>
            {tableNum > 0 && recentHostedPending && minutesSince(recentHostedPending.placed_at) < 10 && (
              <div className="bg-yellow-500/10 border border-yellow-500/40 rounded-xl p-4 mb-2 text-center">
                <p className="text-yellow-100 font-medium font-sans text-sm">
                  A payment is being processed for this table.
                </p>
                <p className="text-yellow-200/80 font-sans text-xs mt-1">
                  Please wait or ask your waiter for assistance.
                </p>
              </div>
            )}
            {tabActionError && isTabPaymentInProgressError(tabActionError) ? (
              <TabPaymentInProgressCard />
            ) : tabActionError ? (
              <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-4 text-left">
                <p className="font-sans text-sm font-medium text-red-100">Could not open tab</p>
                <p className="font-sans text-xs text-red-200/90 mt-1">{tabActionError}</p>
              </div>
            ) : null}
            {tableNum > 0 && (
              <div className="mb-4">
                <input
                  type="text"
                  placeholder="Your name"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value)
                    if (displayNameError && e.target.value.trim()) {
                      setDisplayNameError('')
                    }
                  }}
                  maxLength={30}
                  className="w-full rounded-lg border border-white/20 bg-white/10 px-4 py-3 text-white placeholder-white/40 font-sans text-base focus:outline-none focus:border-white/40"
                />
                {displayNameError ? (
                  <p className="mt-2 text-sm font-sans text-red-300">{displayNameError}</p>
                ) : null}
              </div>
            )}
            {tableNum > 0 && storedTabChecked && !tabLoading && myStoredTab ? (
              <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-6 text-center space-y-4">
                <div>
                  <p className="font-sans text-lg font-semibold text-white">
                    {storedTabIsAtAnotherTable && myStoredTab.tableNumber != null
                      ? TAB_ELSEWHERE_COPY.heading(myStoredTab.tableNumber)
                      : 'Rejoin your tab'}
                  </p>
                  <p className="font-sans text-sm text-white/80 mt-2">
                    Total so far: {currency}{(myStoredTab.total || 0).toFixed(2)}
                  </p>
                  {myStoredTab.status === 'ready_to_pay' && (
                    <p className="font-sans text-xs text-amber-200/90 mt-2">
                      Your tab is ready to pay — your waiter has been notified.
                    </p>
                  )}
                </div>
                <Button
                  size="lg"
                  onClick={handleJoinTab}
                  disabled={tabActionLoading !== null || blockOrderingForHostedPending}
                  className="w-full bg-white text-[#0A0A0A] hover:bg-white/90 text-base font-semibold py-6 font-sans"
                >
                  {tabActionLoading === 'join' ? 'Rejoining…' : 'Rejoin your tab'}
                </Button>
                {/*
                  #211: the second action. Without it "Rejoin your tab" is the ONLY thing offered
                  to a customer sitting at a different table, which is the dead end the issue is
                  about. Which action it is depends on what is waiting at the SCANNED table --
                  join its existing tab (PIN-gated) or start a new one. Offering "start" against a
                  table that already has an open tab would hit the unique index and fall into
                  #218's PIN-less 23505 recovery branch, so the two cases must not be collapsed.
                */}
                {storedTabIsAtAnotherTable && myStoredTab.tableNumber != null && (
                  <div className="space-y-2">
                    {openTab ? (
                      <Button
                        variant="outline"
                        size="lg"
                        onClick={handleJoinTabAtThisTable}
                        disabled={tabActionLoading !== null || blockOrderingForHostedPending}
                        className="w-full border-2 border-white/40 bg-transparent text-white hover:bg-white/10 hover:border-white/60 text-base py-6 font-sans"
                      >
                        {TAB_ELSEWHERE_COPY.joinHere(tableNum)}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="lg"
                        onClick={handleCreateTab}
                        disabled={tabActionLoading !== null || blockOrderingForHostedPending}
                        className="w-full border-2 border-white/40 bg-transparent text-white hover:bg-white/10 hover:border-white/60 text-base py-6 font-sans"
                      >
                        {tabActionLoading === 'create'
                          ? 'Creating tab…'
                          : TAB_ELSEWHERE_COPY.startHere(tableNum)}
                      </Button>
                    )}
                    <p className="font-sans text-xs text-white/60">
                      {TAB_ELSEWHERE_COPY.staysOpen(myStoredTab.tableNumber)}
                    </p>
                  </div>
                )}
                <Button
                  variant="outline"
                  size="lg"
                  onClick={handleViewMenu}
                  disabled={blockOrderingForHostedPending}
                  className="w-full border-2 border-white/40 bg-transparent text-white hover:bg-white/10 hover:border-white/60 text-base py-6 font-sans"
                >
                  View Menu
                </Button>
              </div>
            ) : tableNum > 0 && storedTabChecked && !tabLoading && openTab ? (
              openTab.status === 'ready_to_pay' ? (
                <div className="space-y-4">
                  <TabPaymentInProgressCard />
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={handleViewMenu}
                    disabled={blockOrderingForHostedPending}
                    className="w-full border-2 border-white/40 bg-transparent text-white hover:bg-white/10 hover:border-white/60 text-base py-6 font-sans"
                  >
                    View Menu
                  </Button>
                </div>
              ) : (
              <div className="rounded-xl border border-white/25 bg-white/10 p-6 text-center space-y-4">
                <div>
                  <p className="font-sans text-lg font-semibold text-white">
                    A tab is already open for this table
                  </p>
                  <p className="font-sans text-sm text-white/80 mt-2">
                    Total so far: {currency}{(openTab.total || 0).toFixed(2)}
                  </p>
                  {openTab.members > 0 && (
                    <p className="font-sans text-xs text-white/60 mt-1">
                      {openTab.members} {openTab.members === 1 ? 'person' : 'people'} on this tab
                    </p>
                  )}
                </div>
                <Button
                  size="lg"
                  onClick={handleJoinTab}
                  disabled={tabActionLoading !== null || blockOrderingForHostedPending}
                  className="w-full bg-white text-[#0A0A0A] hover:bg-white/90 text-base font-semibold py-6 font-sans"
                >
                  {tabActionLoading === 'join' ? 'Joining tab…' : 'Join Tab'}
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  onClick={handleViewMenu}
                  disabled={blockOrderingForHostedPending}
                  className="w-full border-2 border-white/40 bg-transparent text-white hover:bg-white/10 hover:border-white/60 text-base py-6 font-sans"
                >
                  View Menu
                </Button>
              </div>
              )
            ) : tableNum > 0 && storedTabChecked ? (
              <>
                <Button
                  size="lg"
                  onClick={handleCreateTab}
                  disabled={tabActionLoading !== null || blockOrderingForHostedPending}
                  className="w-full bg-white text-[#0A0A0A] hover:bg-white/90 text-base font-semibold py-6 font-sans group justify-between"
                >
                  <span className="flex flex-col items-start leading-tight">
                    <span>{tabActionLoading === 'create' ? 'Creating tab…' : 'Create Tab'}</span>
                    <span className="text-xs font-normal text-gray-400">
                      Share a tab with everyone at your table
                    </span>
                  </span>
                  <ChevronRight className="w-5 h-5 ml-2 shrink-0 group-hover:translate-x-1 transition-transform stroke-[2]" />
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  onClick={handleViewMenu}
                  disabled={blockOrderingForHostedPending}
                  className="w-full border-2 border-white/40 bg-transparent text-white hover:bg-white/10 hover:border-white/60 text-base py-6 font-sans"
                >
                  <span className="flex flex-col items-start leading-tight">
                    <span>View Menu</span>
                    <span className="text-xs font-normal text-white/50">
                      Browse and order on your own
                    </span>
                  </span>
                </Button>
              </>
            ) : (
              <Link href={browseBase} className="block">
                <Button
                  size="lg"
                  className="w-full bg-white text-[#0A0A0A] hover:bg-white/90 text-base font-semibold py-6 font-sans group"
                >
                  View Menu & Order
                  <ChevronRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform stroke-[2]" />
                </Button>
              </Link>
            )}

            {/* Secondary: View Receipt */}
            {sessionReady && sessionId && tableNum > 0 && myStoredTab && (
              <Link href={`/menu/${restaurantId}/receipt?table=${tableNum}`} className="block">
              <Button
                variant="outline"
                size="lg"
                className="w-full border-2 border-white/40 bg-transparent text-white hover:bg-white/10 hover:border-white/60 text-base py-6 font-sans"
              >
                <Receipt className="w-5 h-5 mr-2 stroke-[1.5]" />
                View Receipt
              </Button>
            </Link>
            )}
              </>
            )}
          </div>

          {/* Powered by Footer */}
          <div className="pt-12">
            <p className="text-white/20 font-sans text-xs tracking-wide">
              Powered by FlashTap
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function MenuLandingPageV2() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-2 border-white/30 border-t-white animate-spin mx-auto" />
          <p className="mt-6 text-white/60 font-sans text-sm tracking-wide">Loading...</p>
        </div>
      </div>
    }>
      <MenuLandingPageV2Content />
    </Suspense>
  )
}
