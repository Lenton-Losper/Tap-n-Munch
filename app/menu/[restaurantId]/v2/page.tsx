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
import { Receipt, ChevronRight } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { useCart } from '@/contexts/cart-context'
import { useTab } from '@/contexts/tab-context'
import { supabase } from '@/lib/supabase/client'
import { getSupabaseTableByNumber } from '@/lib/supabase/tables'
import {
  ACTIVE_TAB_STATUSES,
  fetchTabById,
  isActiveTabStatus,
  isTabSessionEndedStatus,
} from '@/lib/tab-session'
import {
  clearTabSession,
  persistTabSession,
  readStoredTabId,
  consumeSessionEndedNotice,
  clearActiveOrderBannerState,
  TAB_SESSION_ENDED_MESSAGE,
} from '@/lib/tab-storage'
import { restaurantLogoDisplayUrl } from '@/lib/restaurant-logo'

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
  const [sessionId, setSessionId] = useState<string>('')
  const [sessionReady, setSessionReady] = useState(false)
  const [openTab, setOpenTab] = useState<{ id: string; total: number; members: number } | null>(null)
  const [myStoredTab, setMyStoredTab] = useState<{ id: string; total: number; status: string } | null>(null)
  const [storedTabChecked, setStoredTabChecked] = useState(false)
  const [tabLoading, setTabLoading] = useState(false)
  const [tabActionLoading, setTabActionLoading] = useState<'create' | 'join' | null>(null)
  const [tabActionError, setTabActionError] = useState<string | null>(null)
  const [recentHostedPending, setRecentHostedPending] = useState<{ id: string; placed_at: string } | null>(
    null
  )
  const [sessionEndedNotice, setSessionEndedNotice] = useState(false)
  const { clearCart } = useCart()
  const { createNewTab, joinExistingTab, clearTab } = useTab()

  useEffect(() => {
    if (consumeSessionEndedNotice()) {
      setSessionEndedNotice(true)
      clearActiveOrderBannerState()
      clearTab()
      clearCart()
    }
  }, [clearTab, clearCart])

  // Load restaurant data
  useEffect(() => {
    if (!restaurantId) {
      if (!restaurantId) {
        setError('Restaurant ID is missing from URL')
        setLoading(false)
      }
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

  // Table fetch
  useEffect(() => {
    if (!restaurant || !restaurantId) return
    if (tableNum <= 0) {
      setLoading(false)
      setError(null)
      return
    }

    const loadTableData = async () => {
      try {
        const tableData = await getSupabaseTableByNumber(restaurantId, tableNum, false).catch((err) => {
          console.warn('[V2] table lookup failed', err)
          return null
        })
        if (!tableData) {
          setTable(null)
        } else {
          setTable(tableData)
          const session = createFreshSession(restaurantId, String(tableNum))
          if (session) {
            setSessionId(session)
            setSessionReady(true)
            if (typeof window !== 'undefined') {
              localStorage.setItem('current_restaurant_id', restaurantId)
            }
            clearCart()
          }
        }
      } catch (err: any) {
        setTable(null)
      }
      
      setLoading(false)
      setError(null)
    }
    
    loadTableData()
  }, [restaurant, restaurantId, tableNum])

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
    if (!restaurantId || tableNum <= 0) {
      setMyStoredTab(null)
      setOpenTab(null)
      setStoredTabChecked(true)
      return
    }

    const restaurantUuid = String(restaurant?.id || restaurantId || '')
    const storedId = readStoredTabId()

    if (storedId) {
      const { count: openTableOrders, error: openOrdersError } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantUuid)
        .eq('table_number', tableNum)
        .eq('is_closed', false)
        .not('status', 'in', '("completed","cancelled")')

      if (!openOrdersError && (openTableOrders || 0) === 0) {
        try {
          const tab = await fetchTabById(storedId, restaurantUuid)
          if (
            !tab ||
            isTabSessionEndedStatus(tab.status) ||
            String(tab.status || '').toLowerCase() === 'ready_to_pay'
          ) {
            endTabSession(true)
            setStoredTabChecked(true)
            return
          }
        } catch (err) {
          console.warn('[V2] open-order tab check failed', err)
        }
      }
    }

    if (!storedId) {
      setMyStoredTab(null)
      const { count: openOrdersCount, error: openOrdersErr } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantUuid)
        .eq('table_number', tableNum)
        .eq('is_closed', false)
        .not('status', 'in', '("completed","cancelled")')
      if (!openOrdersErr && (openOrdersCount || 0) === 0) {
        clearActiveOrderBannerState()
      }
    } else {
      try {
        const tab = await fetchTabById(storedId, restaurantUuid)
        if (!tab || isTabSessionEndedStatus(tab.status)) {
          endTabSession(Boolean(storedId))
        } else if (isActiveTabStatus(tab.status)) {
          persistTabSession(storedId, tableNum)
          setMyStoredTab({
            id: String(tab.id),
            total: Number(tab.total) || 0,
            status: String(tab.status || 'open'),
          })
        } else {
          endTabSession(Boolean(storedId))
        }
      } catch (err) {
        console.warn('[V2] stored tab validation failed', err)
        endTabSession(Boolean(storedId))
      }
    }

    setStoredTabChecked(true)

    if (readStoredTabId()) {
      setOpenTab(null)
      return
    }

    try {
      setTabLoading(true)
      const cutoffIso = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()
      let tabQuery = supabase
        .from('tabs')
        .select('*')
        .eq('restaurant_id', restaurantUuid)
        .in('status', [...ACTIVE_TAB_STATUSES])
        .gte('created_at', cutoffIso)

      if (table?.id) {
        tabQuery = tabQuery.eq('table_id', table.id)
      } else {
        tabQuery = tabQuery.eq('table_number', tableNum)
      }

      const { data: candidates, error: tabQueryError } = await tabQuery.limit(1)
      if (tabQueryError) {
        console.error('[TAB CHECK] query error:', tabQueryError)
      }

      const tabData = (candidates || []).find((row) =>
        isActiveTabStatus(String((row as Record<string, unknown>).status || ''))
      ) as Record<string, any> | undefined

      if (!tabData) {
        setOpenTab(null)
        return
      }

      setOpenTab({
        id: String(tabData.id),
        total: Number(tabData.total) || 0,
        members: Array.isArray(tabData.members) ? tabData.members.length : 0,
      })
    } catch (tabErr) {
      console.error('Failed to load open tab:', tabErr)
      setOpenTab(null)
    } finally {
      setTabLoading(false)
    }
  }, [restaurantId, restaurant?.id, tableNum, table, endTabSession])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await syncTabLandingState()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [syncTabLandingState])

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

  useEffect(() => {
    if (!restaurantId || tableNum <= 0) {
      setRecentHostedPending(null)
      return
    }
    let cancelled = false
    const run = async () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
      const { data: abandoned } = await supabase
        .from('orders')
        .select('id, placed_at')
        .eq('restaurant_id', restaurantId)
        .eq('table_number', tableNum)
        .eq('payment_status', 'pending')
        .eq('payment_channel', 'hosted')
        .eq('is_closed', false)
        .lt('placed_at', tenMinutesAgo)

      if (!cancelled && abandoned && abandoned.length > 0) {
        try {
          await fetch('/api/orders/expire-pending', { method: 'POST' })
        } catch (e) {
          console.warn('[TABLE] expire-pending failed', e)
        }
      }

      const { data: recentPending } = await supabase
        .from('orders')
        .select('id, placed_at')
        .eq('restaurant_id', restaurantId)
        .eq('table_number', tableNum)
        .eq('payment_status', 'pending')
        .eq('payment_channel', 'hosted')
        .eq('is_closed', false)
        .gte('placed_at', tenMinutesAgo)
        .order('placed_at', { ascending: false })
        .limit(1)

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
  }, [restaurantId, tableNum])

  const minutesSince = (iso: string) => {
    const t = new Date(iso).getTime()
    if (Number.isNaN(t)) return 0
    return Math.floor((Date.now() - t) / 60_000)
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

  const handleCreateTab = async () => {
    if (!restaurantId || tableNum <= 0) {
      setTabActionError('Missing restaurant or table number. Scan the table QR code again.')
      console.error('[V2] create tab blocked — missing restaurantId or tableNum', { restaurantId, tableNum })
      return
    }
    try {
      setTabActionLoading('create')
      setTabActionError(null)
      console.log('[V2] create tab clicked', { restaurantId, tableNum, tableId: table?.id })
      const tid = await createNewTab({
        restaurantId,
        tableNumber: String(tableNum),
        tableId: table?.id ? String(table.id) : undefined,
      })
      console.log('[V2] create tab redirecting to browse', { tid })
      router.push(browseWithTab(tid))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create tab. Please try again.'
      console.error('[V2] create tab failed:', err)
      setTabActionError(message)
    } finally {
      setTabActionLoading(null)
    }
  }

  const handleJoinTab = async () => {
    const joinTabId = myStoredTab?.id || openTab?.id
    if (!restaurantId || !joinTabId) {
      setTabActionError('No open tab found to join.')
      return
    }
    try {
      setTabActionLoading('join')
      setTabActionError(null)
      console.log('[V2] join tab clicked', { restaurantId, tabId: joinTabId, rejoin: Boolean(myStoredTab) })
      await joinExistingTab({ restaurantId, tabId: joinTabId, tableNumber: tableNum })
      console.log('[V2] join tab redirecting to browse', { tabId: joinTabId })
      router.push(browseWithTab(joinTabId))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to join tab. Please try again.'
      console.error('[V2] join tab failed:', err)
      setTabActionError(message)
    } finally {
      setTabActionLoading(null)
    }
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

  return (
    <div className="min-h-screen bg-[#0A0A0A] relative overflow-hidden">
      <OrderStatusBanner restaurantId={restaurantId} tableNumber={tableNum} />
      {sessionEndedNotice && (
        <div className="relative z-30 px-4 pt-4">
          <div className="mx-auto max-w-md rounded-lg border border-amber-500/40 bg-amber-500/15 px-4 py-3 text-center text-sm text-amber-100">
            {TAB_SESSION_ENDED_MESSAGE}
          </div>
        </div>
      )}
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
            {tabActionError && (
              <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-4 text-left">
                <p className="font-sans text-sm font-medium text-red-100">Could not open tab</p>
                <p className="font-sans text-xs text-red-200/90 mt-1">{tabActionError}</p>
              </div>
            )}
            {tableNum > 0 && storedTabChecked && !tabLoading && myStoredTab ? (
              <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-6 text-center space-y-4">
                <div>
                  <p className="font-sans text-lg font-semibold text-white">Rejoin your tab</p>
                  <p className="font-sans text-sm text-white/80 mt-2">
                    Total so far: {(restaurant?.currency || 'NAD')}{(myStoredTab.total || 0).toFixed(2)}
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
              <div className="rounded-xl border border-white/25 bg-white/10 p-6 text-center space-y-4">
                <div>
                  <p className="font-sans text-lg font-semibold text-white">
                    A tab is already open for this table
                  </p>
                  <p className="font-sans text-sm text-white/80 mt-2">
                    Total so far: {(restaurant?.currency || 'NAD')}{(openTab.total || 0).toFixed(2)}
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
            ) : tableNum > 0 && storedTabChecked ? (
              <>
                <Button
                  size="lg"
                  onClick={handleCreateTab}
                  disabled={tabActionLoading !== null || blockOrderingForHostedPending}
                  className="w-full bg-white text-[#0A0A0A] hover:bg-white/90 text-base font-semibold py-6 font-sans group"
                >
                  {tabActionLoading === 'create' ? 'Creating tab…' : 'Create Tab'}
                  <ChevronRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform stroke-[2]" />
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
