'use client'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useRestaurant } from '@/contexts/restaurant-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import Image from 'next/image'
import { restaurantLogoDisplayUrl } from '@/lib/restaurant-logo'
import { startKioskCustomerSession } from '@/lib/session'
import { getSupabaseTableByNumber } from '@/lib/supabase/tables'
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'

export default function KioskPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableParam = searchParams.get('table') || '99'
  const tableNumber = parseInt(tableParam, 10) || 0
  const { restaurant, loading } = useRestaurant()

  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [tableReady, setTableReady] = useState(false)
  const [tableBlocked, setTableBlocked] = useState<string | null>(null)
  const resetRequested = searchParams.get('reset') === 'true'
  const [clearedReset, setClearedReset] = useState(false)
  const invalidLink = !restaurantId || tableNumber <= 0
  if (resetRequested && !clearedReset) {
    setClearedReset(true)
    if (name) setName('')
    if (error) setError('')
  }
  if (!resetRequested && clearedReset) {
    setClearedReset(false)
  }

  useEffect(() => {
    if (invalidLink) return
    let cancelled = false
    void getSupabaseTableByNumber(restaurantId, tableNumber, false)
      .then((row) => {
        if (cancelled) return
        if (!row.is_kiosk) {
          setTableBlocked(MENU_COPY.thisLinkNotConfiguredAs)
          return
        }
        setTableReady(true)
      })
      .catch(() => {
        if (!cancelled) setTableBlocked(MENU_COPY.thisKioskNotAvailableOrdering)
      })
    return () => {
      cancelled = true
    }
  }, [restaurantId, tableNumber, invalidLink])

  const handleStart = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError(MENU_COPY.pleaseEnterYourNameContinue)
      return
    }
    if (trimmed.length < 2) {
      setError(MENU_COPY.nameMustLeast2Characters)
      return
    }

    // Begin new customer lifecycle — clears previous session, tab, cart
    startKioskCustomerSession(restaurantId, tableParam)

    router.push(
      `/menu/${restaurantId}/browse?table=${tableParam}&kiosk=true&name=${encodeURIComponent(trimmed)}`
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleStart()
  }

  if (loading || (tableNumber > 0 && !invalidLink && !tableReady && !tableBlocked)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900" />
      </div>
    )
  }

  if (invalidLink || tableBlocked) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 text-center">
        <p className="text-lg text-gray-700">
          {invalidLink ? MENU_COPY.thisKioskLinkInvalid : tableBlocked}
        </p>
      </div>
    )
  }

  const logoUrl = restaurantLogoDisplayUrl(restaurantId, restaurant?.logo_url)

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6">
      <div className="w-full max-w-sm flex flex-col items-center gap-8">
        {logoUrl && (
          <Image
            src={logoUrl}
            alt={restaurant?.name || 'Restaurant'}
            width={120}
            height={120}
            className="rounded-2xl object-cover"
          />
        )}

        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">{restaurant?.name}</h1>
          <p className="mt-2 text-gray-500 text-lg">{MENU_COPY.welcomeEnterYourNameStart}</p>
        </div>

        <div className="w-full flex flex-col gap-3">
          <Input
            autoFocus
            placeholder={MENU_COPY.yourName}
            value={name}
            onChange={e => { setName(e.target.value); setError('') }}
            onKeyDown={handleKeyDown}
            className="h-14 text-lg text-center"
            maxLength={40}
          />
          {error && <p className="text-sm text-red-500 text-center">{error}</p>}
          <Button
            onClick={handleStart}
            className="h-14 text-lg font-semibold w-full"
            disabled={!name.trim()}
          >
            {MENU_COPY.startOrder}
          </Button>
        </div>

        <p className="text-xs text-gray-400 text-center">
          {MENU_COPY.tapStartOrderBrowseMenu}
        </p>
      </div>
    </div>
  )
}
