'use client'

import { Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

function OrderConfirmationContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const tn = searchParams.get('tn')

  const goBackToMenu = () => {
    if (typeof window === 'undefined') return
    const restaurantId = localStorage.getItem('current_restaurant_id')
    const tableFromQuery = searchParams.get('table')
    const tableFromSession =
      typeof window !== 'undefined' ? sessionStorage.getItem('flashtap_return_table') : null
    const table = tableFromQuery || tableFromSession || ''
    if (restaurantId && table) {
      router.push(`/menu/${restaurantId}/v2?table=${encodeURIComponent(table)}`)
      return
    }
    if (restaurantId) {
      router.push(`/menu/${restaurantId}/browse`)
      return
    }
    router.push('/')
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-card border border-border p-10 text-center space-y-6">
        <div className="text-5xl" aria-hidden>
          ✓
        </div>
        <h1 className="text-2xl font-serif font-bold text-foreground">
          Payment successful! Your order is being prepared.
        </h1>
        {tn ? (
          <p className="text-muted-foreground font-sans text-sm">
            Order reference: <span className="text-foreground font-medium break-all">{tn}</span>
          </p>
        ) : null}
        <Button
          type="button"
          onClick={goBackToMenu}
          className="w-full bg-foreground text-background hover:bg-foreground/90 py-6 font-semibold font-sans"
        >
          Back to menu
        </Button>
      </div>
    </div>
  )
}

export default function OrderConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
        </div>
      }
    >
      <OrderConfirmationContent />
    </Suspense>
  )
}
