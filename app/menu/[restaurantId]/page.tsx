'use client'

import { useEffect } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'

export const dynamic = "force-dynamic"

/**
 * Cache-Busting Redirect: Old route redirects to new v2 route
 * This forces browsers to download fresh JavaScript and bypasses cache issues
 */
export default function MenuLandingPage({
}: {
  params: { restaurantId: string }
  searchParams: { table?: string }
}) {
  const router = useRouter()
  const routeParams = useParams()
  const queryParams = useSearchParams()
  const restaurantId = (routeParams?.restaurantId as string) || ''
  const tableNumber = queryParams?.get('table') || ''

  useEffect(() => {
    if (!restaurantId) {
      router.replace('/')
      return
    }

    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', window.location.href)
    }

    const tableParam = tableNumber ? `?table=${tableNumber}` : ''
    router.replace(`/menu/${restaurantId}/v2${tableParam}`)
  }, [restaurantId, tableNumber, router])

  return null
}
