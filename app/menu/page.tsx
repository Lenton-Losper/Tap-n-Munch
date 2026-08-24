'use client'

export const dynamic = "force-dynamic"

import { useEffect, useState, Suspense } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import { getRestaurantByFirebaseId } from '@/lib/supabase/restaurants'
import { getSupabaseTableByNumber } from '@/lib/supabase/tables'
import { getOrCreateSession, getCurrentSession } from '@/lib/session'
import { restoreSessionFromTable } from '@/lib/session-recovery'
import { ActiveOrderBanner } from '@/components/ActiveOrderBanner'
import { Button } from '@/components/ui/button'
import { ShoppingCart, AlertCircle } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { restaurantLogoDisplayUrl } from '@/lib/restaurant-logo'
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'

function MenuLandingPageContent() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { loading: authLoading } = useAuth()
  const restaurantId = params.restaurantId as string
  
  const tableNumberParam = searchParams.get('table')
  const tableNum = tableNumberParam ? Number(tableNumberParam.replace(/\D/g, '')) : 0
  
  const [restaurant, setRestaurant] = useState<any>(null)
  const [table, setTable] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string>('')
  const [sessionReady, setSessionReady] = useState(false)
  const [permissionError, setPermissionError] = useState(false)
  const [initialized] = useState(() => {
    if (typeof window === 'undefined') return false
    const oldKeys = [
      'table_session_id',
      'table_session_restaurant',
      'table_session_table',
      'session_id',
    ]
    oldKeys.forEach((key) => {
      if (localStorage.getItem(key)) {
        localStorage.removeItem(key)
      }
    })
    return true
  })

  const canLoadRestaurant = Boolean(restaurantId)
  const missingRestaurantError =
    !authLoading && initialized && !restaurantId
      ? MENU_COPY.invalidMenuUrlPleaseScan
      : null
  const displayError = error ?? missingRestaurantError

  useEffect(() => {
    if (!canLoadRestaurant) return

    let cancelled = false
    const timeoutId = setTimeout(() => {
      if (!cancelled && loading && !restaurant) {
        setError(MENU_COPY.loadingTookTooLongPlease)
        setLoading(false)
      }
    }, 5000)

    ;(async () => {
      try {
        const restaurantData = await getRestaurantByFirebaseId(restaurantId)
        if (cancelled) return
        setRestaurant(restaurantData)
        setError(null)
      } catch (err: any) {
        if (cancelled) return
        setPermissionError(Boolean(err?.message?.includes('permission')))
        setError(err?.message || MENU_COPY.failedLoadRestaurantPleaseTry)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [canLoadRestaurant, restaurantId, loading, restaurant])

  useEffect(() => {
    if (!restaurant || !restaurantId) return

    const loadTableData = async () => {
      if (tableNum > 0) {
        try {
          const tableData = await getSupabaseTableByNumber(restaurantId, tableNum, true)
          
          if (tableData) {
            setTable(tableData)
            
            let session = getCurrentSession()
            if (!session) {
              const recovered = await restoreSessionFromTable(restaurantId, tableNum)
              session = recovered || getOrCreateSession(restaurantId, String(tableNum))
            }
            
            if (session) {
              setSessionId(session)
              setSessionReady(true)
            }
          }
        } catch (err: any) {
          if (err?.code === 'permission-denied' || err?.message?.includes('permission')) {
            setPermissionError(true)
            setError(MENU_COPY.pleaseAskStaffOpenThis)
          }
        }
      }
      setLoading(false)
    }

    loadTableData()
  }, [restaurant, restaurantId, tableNum])

  if (authLoading || !initialized) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin mx-auto" />
          <p className="mt-6 text-muted-foreground font-sans">Loading...</p>
        </div>
      </div>
    )
  }

  if (!restaurantId) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 text-center">
        <AlertCircle className="w-12 h-12 text-foreground mb-6 stroke-[1.5]" />
        <h1 className="text-2xl font-serif font-bold text-foreground mb-4">{MENU_COPY.invalidMenuUrl}</h1>
        <p className="text-muted-foreground font-sans mb-6">
          {MENU_COPY.thisMenuPageRequiresRestaurant}
        </p>
        <p className="text-sm text-muted-foreground font-sans mb-8">
          Please scan a valid QR code or use a menu link with the format: /menu/[restaurantId]
        </p>
        <Button
          onClick={() => router.push('/signin')}
          className="bg-foreground text-background hover:bg-foreground/90 font-sans"
        >
          {MENU_COPY.goSign}
        </Button>
      </div>
    )
  }

  const showPageLoading = canLoadRestaurant && loading

  if (showPageLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin mx-auto" />
          <p className="mt-6 text-muted-foreground font-sans">Scanning...</p>
          {displayError && (
            <p className="mt-3 text-sm text-destructive font-sans">{displayError}</p>
          )}
        </div>
      </div>
    )
  }

  if (displayError || !restaurant) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 text-center">
        <AlertCircle className="w-12 h-12 text-foreground mb-6 stroke-[1.5]" />
        <h1 className="text-2xl font-serif font-bold text-foreground mb-4">
          {permissionError ? MENU_COPY.accessRestricted : MENU_COPY.restaurantNotFound}
        </h1>
        <p className="text-muted-foreground font-sans mb-6">
          {displayError || MENU_COPY.linkYouFollowedMayInvalid}
        </p>
        {permissionError && (
          <div className="p-4 bg-muted border border-border max-w-md mb-6">
            <p className="text-sm text-muted-foreground font-sans">
              {MENU_COPY.thisTableMayNotOpen}
            </p>
          </div>
        )}
        <div className="space-y-3">
          <Button
            onClick={() => window.location.reload()}
            className="bg-foreground text-background hover:bg-foreground/90 font-sans"
          >
            Retry
          </Button>
          <Button
            onClick={() => router.push('/')}
            variant="outline"
            className="w-full border-border font-sans"
          >
            {MENU_COPY.goHome}
          </Button>
        </div>
        <div className="mt-8 p-4 bg-muted border border-border text-xs font-mono text-left max-w-md">
          <p className="text-muted-foreground">Restaurant ID: {restaurantId}</p>
          <p className="text-muted-foreground">Table Number: {tableNum > 0 ? tableNum : MENU_COPY.notProvided}</p>
          <p className="text-muted-foreground">Table Found: {table ? 'Yes' : 'No'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <ActiveOrderBanner />
      
      <div className="flex flex-col items-center justify-center p-8 flex-1">
        <div className="w-full max-w-md text-center space-y-8">
          {/* Logo */}
          <div className="flex justify-center">
            {restaurantLogoDisplayUrl(restaurantId, restaurant.logo_url) ? (
              <Image
                src={restaurantLogoDisplayUrl(restaurantId, restaurant.logo_url)!}
                alt={restaurant.name}
                width={120}
                height={120}
                className="object-cover border border-border"
              />
            ) : (
              <div className="w-24 h-24 bg-foreground flex items-center justify-center text-background text-3xl font-serif font-bold">
                {restaurant.name?.charAt(0)}
              </div>
            )}
          </div>

          {/* Restaurant Info */}
          <div className="space-y-3">
            <h1 className="text-5xl font-serif font-bold text-foreground tracking-tight">{restaurant.name}</h1>
            <p className="text-sm font-sans text-muted-foreground italic">{restaurant.description || MENU_COPY.welcomeOurMenu}</p>
          </div>

          {/* Table Card */}
          <div className="bg-card p-6 border border-border">
            {tableNum > 0 ? (
              <div className="mb-6">
                <span className="text-xs font-sans uppercase tracking-widest text-muted-foreground font-semibold">{MENU_COPY.yourLocation}</span>
                <p className="text-2xl font-serif font-bold text-foreground mt-1">Table {tableNum}</p>
                {!table && <p className="text-xs font-sans text-destructive mt-1">{MENU_COPY.noteTableNotVerifiedOrdering}</p>}
              </div>
            ) : (
              <p className="text-sm font-sans text-muted-foreground mb-6">{MENU_COPY.scanQrCodeYourTable}</p>
            )}

            <Link href={`/menu/${restaurantId}/browse${tableNum > 0 ? `?table=${tableNum}` : ''}`}>
              <Button size="lg" className="w-full bg-foreground text-background hover:bg-foreground/90 py-7 text-xl transition-all active:scale-95 font-sans">
                <ShoppingCart className="w-6 h-6 mr-2 stroke-[1.5]" />
                {MENU_COPY.viewFullMenu}
              </Button>
            </Link>
          </div>

          {/* Receipt Link */}
          {sessionReady && sessionId && tableNum > 0 && (
            <Link href={`/menu/${restaurantId}/receipt?table=${tableNum}`}>
              <Button variant="ghost" className="w-full text-foreground hover:bg-muted text-lg font-sans">
                {MENU_COPY.viewMyCurrentReceipt}
              </Button>
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

export default function MenuLandingPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
      </div>
    }>
      <MenuLandingPageContent />
    </Suspense>
  )
}
