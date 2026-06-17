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
    console.log('[MENU-ROOT] mounting, restaurantId:', restaurantId, 'tableNumber:', tableNumber)
    console.log('[MENU-ROOT] URL:', typeof window !== 'undefined' ? window.location.href : 'server')
    if (!restaurantId) {
      router.replace('/')
      return
    }
    if (sessionStorage.getItem('flashtap_session_token') || localStorage.getItem('flashtap_session_token')) {
      console.log('[MENU-ROOT] token exists, checking...')
    }
    const tableParam = tableNumber ? `?table=${tableNumber}` : ''
    console.log('[MENU-ROOT] redirecting to v2', tableParam)
    router.replace(`/menu/${restaurantId}/v2${tableParam}`)
  }, [restaurantId, tableNumber, router])

  return null
}
