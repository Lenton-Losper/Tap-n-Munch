export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import { StockSubNav } from '@/components/stock/stock-sub-nav'
import { OrganizationLocationSwitcher } from '@/components/stock/organization-location-switcher'
import { OrganizationTransfersPanel } from '@/components/stock/organization-transfers-panel'
import { PERMISSIONS } from '@/lib/permissions'
import { authorize, authorizeOrganization } from '@/lib/permissions/authorize'
import { requireStockPermission } from '@/lib/stock/auth'
import {
  getAllOrganizationTransfers,
  getOrganizationIdForRestaurant,
  getOrganizationRestaurants,
} from '@/lib/stock/transfer-queries'

export default async function AllLocationsTransfersPage() {
  const { supabase, userId, restaurantId } = await requireStockPermission(PERMISSIONS.STOCK_VIEW)

  const organizationId = await getOrganizationIdForRestaurant(supabase, restaurantId)
  if (!organizationId) {
    redirect('/stock/transfers')
  }

  const canViewAllLocations = await authorizeOrganization(userId, organizationId, 'view_all_locations')
  if (!canViewAllLocations) {
    redirect('/stock/transfers')
  }

  const [transfers, restaurants, canReceive, restaurantName] = await Promise.all([
    getAllOrganizationTransfers(supabase, organizationId),
    getOrganizationRestaurants(supabase, organizationId),
    authorize(userId, restaurantId, PERMISSIONS.STOCK_RECEIVE),
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
        <OrganizationLocationSwitcher restaurantName={restaurantName} />
        <div>
          <h2 className="font-serif text-xl font-semibold text-[#37352F]">All locations</h2>
          <p className="mt-1 text-sm text-[#6B675F]">
            Every transfer across your organization, regardless of which location it involves.
          </p>
        </div>
        <OrganizationTransfersPanel transfers={transfers} restaurants={restaurants} />
      </div>
    </div>
  )
}
