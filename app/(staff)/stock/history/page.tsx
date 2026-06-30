export const dynamic = 'force-dynamic'

import { Suspense } from 'react'
import { RoleGuard } from '@/components/auth/role-guard'
import { MovementHistoryPanel } from '@/components/stock/movement-history-panel'
import { StockSubNav } from '@/components/stock/stock-sub-nav'
import { requireStockOwner } from '@/lib/stock/auth'
import type { MovementDateRange, MovementReason } from '@/lib/stock/format'
import { getActiveStockItems, getMovementHistory } from '@/lib/stock/queries'

type HistoryPageProps = {
  searchParams: Promise<{
    stockItemId?: string
    reason?: string
    dateRange?: string
  }>
}

function isMovementReason(value: string | undefined): value is MovementReason | 'all' {
  if (!value || value === 'all') return true
  return ['received', 'adjustment', 'loss', 'theft', 'recount', 'sale'].includes(value)
}

function isDateRange(value: string | undefined): value is MovementDateRange {
  return value === '7d' || value === '30d' || value === 'all'
}

export default async function StockHistoryPage({ searchParams }: HistoryPageProps) {
  const { supabase, restaurantId } = await requireStockOwner()
  const params = await searchParams

  const stockItemId = params.stockItemId ?? 'all'
  const reason = isMovementReason(params.reason) ? (params.reason ?? 'all') : 'all'
  const dateRange = isDateRange(params.dateRange) ? params.dateRange : '30d'

  const [stockItems, rows] = await Promise.all([
    getActiveStockItems(supabase, restaurantId),
    getMovementHistory(supabase, restaurantId, {
      stockItemId,
      reason,
      dateRange,
    }),
  ])

  return (
    <RoleGuard allowedRoles={['owner']}>
      <div className="min-h-screen bg-[#F7F6F3]">
        <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Movement history</h1>
            <p className="mt-1 text-sm text-[#6B675F]">
              Read-only ledger of stock changes for your restaurant.
            </p>
            <div className="mt-5">
              <StockSubNav showReceiveButton />
            </div>
          </div>
        </div>

        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <Suspense fallback={<div className="text-sm text-[#6B675F]">Loading filters...</div>}>
            <MovementHistoryPanel rows={rows} stockItems={stockItems} />
          </Suspense>
        </div>
      </div>
    </RoleGuard>
  )
}
