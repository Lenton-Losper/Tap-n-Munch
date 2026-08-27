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
    /**
     * THE SESSION CLIENT HERE IS THE RULING, NOT AN OVERSIGHT — DO NOT SWAP IT.
     *
     * `restaurants` RLS is `id IN (SELECT user_restaurant_ids()) OR owner_id = auth.uid()` with no
     * organisation path, so this returns only the locations the caller personally belongs to, and
     * for most callers that is the empty list. The owner ruled on it: "a permission to create
     * cross-location transfers is not a permission to see every location in the organisation."
     *
     * The elevated alternative exists (`resolveVisibleLocations`, lib/organizations/queries.ts) and
     * is gated on `authorizeOrganization(..., 'view_all_locations')` — organisation-OWNER only.
     * `canCreateForOrg` above is a DIFFERENT organisation permission and must not be used to reach
     * it; `canCreateHere` is a per-restaurant permission and is weaker still.
     *
     * What the empty result MEANS is explained to the user by CreateTransferForm — see the
     * NO_DESTINATIONS_COPY_PENDING block there, which also carries the production measurement.
     *
     * The sibling call is deliberately NOT symmetrical: getOrganizationStockItemsWithConfig takes
     * no client because it uses the service-role one, for the reasons in its own comment.
     */
    getOrganizationRestaurants(supabase, organizationId, restaurantId),
    getOrganizationStockItemsWithConfig(organizationId),
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
