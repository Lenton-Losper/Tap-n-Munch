export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import { StockSubNav } from '@/components/stock/stock-sub-nav'
import { TransferSubNav } from '@/components/stock/transfer-sub-nav'
import { OutgoingTransfersPanel } from '@/components/stock/outgoing-transfers-panel'
import { OrganizationLocationSwitcher } from '@/components/stock/organization-location-switcher'
import { PERMISSIONS } from '@/lib/permissions'
import { authorize, authorizeOrganization } from '@/lib/permissions/authorize'
import { requireStockPermission } from '@/lib/stock/auth'
import {
  canAccessStockTransfers,
  getIncomingTransfers,
  getOrganizationIdForRestaurant,
  getOutgoingTransfers,
} from '@/lib/stock/transfer-queries'

export default async function OutgoingTransfersPage() {
  const { supabase, userId, restaurantId } = await requireStockPermission(PERMISSIONS.STOCK_VIEW)

  if (!(await canAccessStockTransfers(userId, restaurantId))) {
    redirect('/stock')
  }

  const organizationId = await getOrganizationIdForRestaurant(supabase, restaurantId)

  const [outgoing, incoming, canCreate, canDispatch, canReceive, canViewAllLocations, restaurantName] =
    await Promise.all([
      getOutgoingTransfers(supabase, restaurantId),
      getIncomingTransfers(supabase, restaurantId),
      authorize(userId, restaurantId, PERMISSIONS.STOCK_TRANSFER_CREATE),
      authorize(userId, restaurantId, PERMISSIONS.STOCK_TRANSFER_DISPATCH),
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
        <OutgoingTransfersPanel transfers={outgoing} canDispatch={canDispatch} canCancel={canCreate} />
      </div>
    </div>
  )
}
