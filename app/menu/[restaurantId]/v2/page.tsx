'use client'

export const dynamic = "force-dynamic"

import { useEffect, useState, Suspense } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { createFreshSession } from '@/lib/session'
import { ActiveOrderBanner } from '@/components/ActiveOrderBanner'
import OrderStatusBanner from '@/components/OrderStatusBanner'
import { Button } from '@/components/ui/button'
import { Receipt, ChevronRight } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { doc, onSnapshot, collection, query, where, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { useCart } from '@/contexts/cart-context'
import { useTab } from '@/contexts/tab-context'
import { tabsPath } from '@/lib/firebase/paths'
import { supabase } from '@/lib/supabase/client'

function MenuLandingPageV2Content() {
  console.log("🚀 [SYSTEM LIVE] Luxury Theme - Landing Page v3.0")
  
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params?.restaurantId as string | undefined
  const tableNumberParam = searchParams?.get('table')
  const tableNum = tableNumberParam ? Number(tableNumberParam) : 0
  
  const [restaurant, setRestaurant] = useState<any>(null)
  const [table, setTable] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string>('')
  const [sessionReady, setSessionReady] = useState(false)
  const [openTab, setOpenTab] = useState<{ id: string; total: number; members: number } | null>(null)
  const [tabLoading, setTabLoading] = useState(false)
  const [tabActionLoading, setTabActionLoading] = useState<'create' | 'join' | null>(null)
  const [recentHostedPending, setRecentHostedPending] = useState<{ id: string; placed_at: string } | null>(
    null
  )
  const { clearCart } = useCart()
  const { createNewTab, joinExistingTab, clearTab } = useTab()

  // Load restaurant data
  useEffect(() => {
    if (!restaurantId || !db) {
      if (!restaurantId) {
        setError('Restaurant ID is missing from URL')
        setLoading(false)
      }
      return
    }

    const restaurantRef = doc(db, 'restaurants', restaurantId)
    const unsubscribe = onSnapshot(
      restaurantRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const restaurantData = { id: docSnap.id, ...docSnap.data() } as any
          setRestaurant(restaurantData)
          setLoading(false)
        } else {
          setError(`Restaurant not found. ID: ${restaurantId}`)
          setLoading(false)
        }
      },
      (err) => {
        if (err?.code === 'permission-denied' || err?.message?.includes('permission')) {
          setError('Please scan a valid QR code to access this restaurant menu.')
          setLoading(false)
          return
        }
        
        getRestaurant(restaurantId).then((data) => {
          if (data) {
            setRestaurant(data)
          } else {
            setError(`Restaurant not found. Please scan a valid QR code.`)
          }
          setLoading(false)
        }).catch((fetchErr: any) => {
          if (fetchErr?.code === 'permission-denied' || fetchErr?.message?.includes('permission')) {
            setError('Please scan a valid QR code to access this restaurant menu.')
          } else {
            setError(`Restaurant not found. Please scan a valid QR code.`)
          }
          setLoading(false)
        })
      }
    )

    return () => unsubscribe()
  }, [restaurantId])

  // Table fetch
  useEffect(() => {
    if (!restaurant || !restaurantId || !db) return
    if (tableNum <= 0) {
      setLoading(false)
      setError(null)
      return
    }

    const loadTableData = async () => {
      try {
        const tablesRef = collection(db, 'restaurants', restaurantId, 'tables')
        const q = query(tablesRef, where('table_number', '==', tableNum))
        const snapshot = await getDocs(q)
        
        if (snapshot.empty) {
          setTable(null)
        } else {
          const tableDoc = snapshot.docs[0]
          const tableData = tableDoc.data()
          
          if (tableData.active !== true) {
            setTable(null)
          } else {
            setTable({ id: tableDoc.id, ...tableData })
            
            // Treat QR landing as a fresh scan session start.
            const session = createFreshSession(restaurantId, String(tableNum))
            if (session) {
              setSessionId(session)
              setSessionReady(true)

              if (typeof window !== 'undefined') {
                localStorage.setItem('current_restaurant_id', restaurantId)
              }

              // Ensure cart starts empty for each fresh QR session.
              clearCart()
            }
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

  useEffect(() => {
    const loadOpenTab = async () => {
      if (!restaurantId || !db || tableNum <= 0) {
        setOpenTab(null)
        return
      }
      try {
        setTabLoading(true)
        console.log('[TAB CHECK] Querying for open tab at table:', tableNum)
        console.log('[TAB CHECK] restaurantId:', restaurantId)
        const tabsRef = collection(db, tabsPath(restaurantId))
        const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000)
        const openTabsQuery = query(tabsRef, where('status', '==', 'open'))
        const snapshot = await getDocs(openTabsQuery)
        const candidates = snapshot.docs.filter((d) => {
          const data = d.data() as Record<string, any>
          const tableVal = data.table_number
          const createdAtRaw = data.created_at
          const createdAt =
            createdAtRaw && typeof createdAtRaw.toDate === 'function'
              ? createdAtRaw.toDate()
              : createdAtRaw instanceof Date
              ? createdAtRaw
              : null
          const tableMatches = String(tableVal) === String(tableNum)
          const within12Hours = createdAt ? createdAt >= cutoff : false
          return tableMatches && within12Hours
        })
        console.log('[TAB CHECK] Result:', candidates.length, 'tabs found')

        if (candidates.length === 0) {
          setOpenTab(null)
          return
        }
        const tabDoc = candidates[0]
        const tabData = tabDoc.data() as Record<string, any>
        setOpenTab({
          id: tabDoc.id,
          total: Number(tabData.total) || 0,
          members: Array.isArray(tabData.members) ? tabData.members.length : 0,
        })
      } catch (tabErr) {
        console.error('Failed to load open tab:', tabErr)
        setOpenTab(null)
      } finally {
        setTabLoading(false)
      }
    }
    loadOpenTab()
    const onFocus = () => loadOpenTab()
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus)
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus)
      }
    }
  }, [restaurantId, tableNum])

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
        .eq('firebase_restaurant_id', restaurantId)
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
        .eq('firebase_restaurant_id', restaurantId)
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

  const blockOrderingForHostedPending =
    Boolean(recentHostedPending) &&
    recentHostedPending &&
    minutesSince(recentHostedPending.placed_at) < 10

  const browseBase = `/menu/${restaurantId}/browse${tableNum > 0 ? `?table=${tableNum}` : ''}`
  const browseWithTab = (tid: string) =>
    `${browseBase}${browseBase.includes('?') ? '&' : '?'}tabId=${encodeURIComponent(tid)}`

  const handleOrderSeparately = () => {
    clearTab()
    router.push(browseBase)
  }

  const handleCreateTab = async () => {
    if (!restaurantId || !table || tableNum <= 0) {
      router.push(browseBase)
      return
    }
    try {
      setTabActionLoading('create')
      const tid = await createNewTab({
        restaurantId,
        tableNumber: String(tableNum),
        tableId: String(table.id || `table_${tableNum}`),
      })
      router.push(browseWithTab(tid))
    } catch (err) {
      console.error('Failed to create tab:', err)
    } finally {
      setTabActionLoading(null)
    }
  }

  const handleJoinTab = async () => {
    if (!restaurantId || !openTab?.id) {
      router.push(browseBase)
      return
    }
    try {
      setTabActionLoading('join')
      await joinExistingTab({ restaurantId, tabId: openTab.id })
      router.push(browseWithTab(openTab.id))
    } catch (err) {
      console.error('Failed to join tab:', err)
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
            {restaurant.logo_url ? (
              <div className="w-28 h-28 border-2 border-white/20 overflow-hidden bg-white/10 backdrop-blur-sm">
                <Image
                  src={restaurant.logo_url}
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
              {restaurant.name}
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
            {tableNum > 0 && !tabLoading && openTab && (
              <div className="rounded-lg border border-white/20 bg-white/10 p-3 text-left">
                <p className="font-sans text-sm text-white">
                  Tab running: {(restaurant?.currency || 'N$')}
                  {(openTab.total || 0).toFixed(2)}
                </p>
                <p className="font-sans text-xs text-white/70">{openTab.members} people currently in tab</p>
              </div>
            )}

            {tableNum > 0 ? (
              <>
                {!openTab ? (
                  <Button
                    size="lg"
                    onClick={handleCreateTab}
                    disabled={tabActionLoading !== null || blockOrderingForHostedPending}
                    className="w-full bg-white text-[#0A0A0A] hover:bg-white/90 text-base font-semibold py-6 font-sans group"
                  >
                    {tabActionLoading === 'create' ? 'Creating tab...' : 'Create Tab'}
                    <ChevronRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform stroke-[2]" />
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    onClick={handleJoinTab}
                    disabled={tabActionLoading !== null || blockOrderingForHostedPending}
                    className="w-full bg-white text-[#0A0A0A] hover:bg-white/90 text-base font-semibold py-6 font-sans group"
                  >
                    {tabActionLoading === 'join'
                      ? 'Joining tab...'
                      : `Join Tab • ${restaurant?.currency || 'N$'}${(openTab.total || 0).toFixed(2)}`}
                    <ChevronRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform stroke-[2]" />
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="lg"
                  onClick={handleOrderSeparately}
                  disabled={blockOrderingForHostedPending}
                  className="w-full border-2 border-white/40 bg-transparent text-white hover:bg-white/10 hover:border-white/60 text-base py-6 font-sans"
                >
                  {openTab ? 'Order Separately' : 'Order Now'}
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
            {sessionReady && sessionId && tableNum > 0 && (
              <Link 
                href={`/menu/${restaurantId}/receipt?table=${tableNum}`}
                className="block"
              >
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
