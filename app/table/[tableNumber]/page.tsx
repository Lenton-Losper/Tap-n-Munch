import { Suspense } from 'react'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import {
  isRivieraHost,
  RIVIERA_RESTAURANT_ID,
} from '@/lib/riviera-subdomain'
import { MenuLandingPageV2Content } from '@/app/menu/[restaurantId]/v2/page'

export const dynamic = 'force-dynamic'

function TableLandingFallback() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center">
      <div className="text-center">
        <div className="w-12 h-12 border-2 border-white/30 border-t-white animate-spin mx-auto" />
        <p className="mt-6 text-white/60 font-sans text-sm tracking-wide">Loading...</p>
      </div>
    </div>
  )
}

export default async function RivieraTableLandingPage({
  params,
}: {
  params: Promise<{ tableNumber: string }>
}) {
  const host = (await headers()).get('host')
  if (!isRivieraHost(host)) {
    notFound()
  }

  const { tableNumber } = await params
  const tableNum = Number(tableNumber)
  if (!Number.isFinite(tableNum) || tableNum <= 0) {
    notFound()
  }

  return (
    <Suspense fallback={<TableLandingFallback />}>
      <MenuLandingPageV2Content
        restaurantIdOverride={RIVIERA_RESTAURANT_ID}
        tableNumberOverride={tableNum}
      />
    </Suspense>
  )
}
