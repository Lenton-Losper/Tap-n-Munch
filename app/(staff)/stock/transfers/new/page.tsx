export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CreateTransferForm } from '@/components/stock/create-transfer-form'
import { PERMISSIONS } from '@/lib/permissions'
import { authorize, authorizeOrganization } from '@/lib/permissions/authorize'
import { requireStockPermission } from '@/lib/stock/auth'
import {
  getOrganizationIdForRestaurant,
  getOrganizationRestaurants,
  getOrganizationStockItemsWithConfig,
} from '@/lib/stock/transfer-queries'

export default async function NewTransferPage() {
  const { supabase, userId, restaurantId } = await requireStockPermission(PERMISSIONS.STOCK_VIEW)

  const organizationId = await getOrganizationIdForRestaurant(supabase, restaurantId)
  if (!organizationId) {
    redirect('/stock/transfers')
  }

  const [canCreateHere, canCreateForOrg, restaurantName] = await Promise.all([
    authorize(userId, restaurantId, PERMISSIONS.STOCK_TRANSFER_CREATE),
    authorizeOrganization(userId, organizationId, 'create_cross_location_transfer'),
    supabase
      .from('restaurants')
      .select('name')
      .eq('id', restaurantId)
      .single()
      .then(({ data }) => data?.name ?? 'Your restaurant'),
  ])

  if (!canCreateHere && !canCreateForOrg) {
    redirect('/stock/transfers')
  }

  const [destinations, orgItems] = await Promise.all([
    getOrganizationRestaurants(supabase, organizationId, restaurantId),
    getOrganizationStockItemsWithConfig(supabase, organizationId),
  ])

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Create Transfer</h1>
              <p className="mt-1 text-sm text-[#6B675F]">
                Send stock from {restaurantName} to another location in your organization.
              </p>
            </div>
            <Link href="/stock/transfers" className="text-sm font-medium text-[#6B675F] hover:text-[#37352F]">
              Back to transfers
            </Link>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <CreateTransferForm
          sourceRestaurantId={restaurantId}
          sourceRestaurantName={restaurantName}
          destinations={destinations}
          orgItems={orgItems}
        />
      </div>
    </div>
  )
}
