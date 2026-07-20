export const dynamic = 'force-dynamic'

import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { StockSubNav } from '@/components/stock/stock-sub-nav'
import { TransferSubNav } from '@/components/stock/transfer-sub-nav'
import { TransferHistoryPanel } from '@/components/stock/transfer-history-panel'
import { OrganizationLocationSwitcher } from '@/components/stock/organization-location-switcher'
import { PERMISSIONS } from '@/lib/permissions'
import { authorize, authorizeOrganization } from '@/lib/permissions/authorize'
import { requireStockPermission } from '@/lib/stock/auth'
import {
  canAccessStockTransfers,
  getOrganizationIdForRestaurant,
  getOrganizationStockItemsWithConfig,
  getOutgoingTransfers,
  getIncomingTransfers,
  getTransferHistory,
  type TransferHistoryFilters,
} from '@/lib/stock/transfer-queries'

type HistoryPageProps = {
  searchParams: Promise<{ itemId?: string; dateRange?: string }>
}

function isDateRange(value: string | undefined): value is '7d' | '30d' | 'all' {
  return value === '7d' || value === '30d' || value === 'all'
}

function dateRangeStart(range: '7d' | '30d' | 'all'): string | null {
  if (range === 'all') return null
  const days = range === '7d' ? 7 : 30
  const start = new Date()
  start.setDate(start.getDate() - days)
  start.setHours(0, 0, 0, 0)
  return start.toISOString()
}

export default async function TransferHistoryPage({ searchParams }: HistoryPageProps) {
  const { supabase, userId, restaurantId } = await requireStockPermission(PERMISSIONS.STOCK_VIEW)

  if (!(await canAccessStockTransfers(userId, restaurantId))) {
    redirect('/stock')
  }

  const params = await searchParams

  const itemId = params.itemId && params.itemId !== 'all' ? params.itemId : undefined
  const dateRange = isDateRange(params.dateRange) ? params.dateRange : '30d'

  const organizationId = await getOrganizationIdForRestaurant(supabase, restaurantId)

  const filters: TransferHistoryFilters = {
    dateRangeStart: dateRangeStart(dateRange),
    organizationStockItemId: itemId,
  }

  const [rows, orgItems, outgoing, incoming, canCreate, canReceive, canViewAllLocations, restaurantName] =
    await Promise.all([
      getTransferHistory(supabase, restaurantId, filters),
      organizationId ? getOrganizationStockItemsWithConfig(organizationId) : Promise.resolve([]),
      getOutgoingTransfers(supabase, restaurantId),
      getIncomingTransfers(supabase, restaurantId),
      authorize(userId, restaurantId, PERMISSIONS.STOCK_TRANSFER_CREATE),
      authorize(userId, restaurantId, PERMISSIONS.STOCK_RECEIVE),
      organizationId
        ? authorizeOrganization(userId, organizationId, 'view_all_locations')
        : Promise.resolve(false),
      supabase
        .from('restaurants')
        .select('name')
        .eq('id', restaurantId)
        .single()
        .then(({ data }) => data?.name ?? 'Your restaurant'),
    ])

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Stock Management</h1>
          <p className="mt-1 text-sm text-[#6B675F]">Track inventory levels and record deliveries.</p>
          <div className="mt-5">
            <StockSubNav showReceiveButton={canReceive} showTransfersTab />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {canViewAllLocations ? <OrganizationLocationSwitcher restaurantName={restaurantName} /> : null}
        <TransferSubNav
          showCreateButton={canCreate}
          outgoingCount={outgoing.length}
          incomingCount={incoming.length}
        />
        <Suspense fallback={<div className="text-sm text-[#6B675F]">Loading filters...</div>}>
          <TransferHistoryPanel rows={rows} orgItems={orgItems} restaurantId={restaurantId} />
        </Suspense>
      </div>
    </div>
  )
}
