export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { ReceiveStockForm } from '@/components/stock/receive-stock-form'
import { StockSubNav } from '@/components/stock/stock-sub-nav'
import { PERMISSIONS } from '@/lib/permissions'
import { authorize } from '@/lib/permissions/authorize'
import { requireStockPermission } from '@/lib/stock/auth'
import { getMeasurementUnitsForRestaurant } from '@/lib/measurement-units/queries'
import { getActiveStockItems } from '@/lib/stock/queries'

export default async function ReceiveStockPage() {
  const { supabase, userId, restaurantId } = await requireStockPermission(PERMISSIONS.STOCK_RECEIVE)
  const [stockItems, measurementUnits, canViewCosts] = await Promise.all([
    getActiveStockItems(supabase, restaurantId),
    getMeasurementUnitsForRestaurant(supabase, restaurantId),
    authorize(userId, restaurantId, PERMISSIONS.STOCK_VIEW_COSTS),
  ])

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Receive Delivery</h1>
              <p className="mt-1 text-sm text-[#6B675F]">
                Record a new delivery for this restaurant.
              </p>
            </div>
            <Link href="/stock" className="text-sm font-medium text-[#6B675F] hover:text-[#37352F]">
              Back to overview
            </Link>
          </div>
          <div className="mt-5">
            <StockSubNav />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <ReceiveStockForm
          stockItems={stockItems}
          measurementUnits={measurementUnits}
          showUnitCost={canViewCosts}
        />
      </div>
    </div>
  )
}
