export const dynamic = 'force-dynamic'

import { StockSubNav } from '@/components/stock/stock-sub-nav'
import { StockOverviewPanel } from '@/components/stock/stock-overview-panel'
import { getMeasurementUnitsForRestaurant } from '@/lib/measurement-units/queries'
import { PERMISSIONS } from '@/lib/permissions'
import { authorize } from '@/lib/permissions/authorize'
import { requireStockPermission } from '@/lib/stock/auth'
import { getStockOverview } from '@/lib/stock/queries'

type StockPageProps = {
  searchParams: Promise<{ received?: string; showInactive?: string }>
}

export default async function StockPage({ searchParams }: StockPageProps) {
  const { supabase, userId, restaurantId } = await requireStockPermission(PERMISSIONS.STOCK_VIEW)
  const params = await searchParams
  const showInactive = params.showInactive === '1'
  const [data, canAdjust, canReceive, canViewRecipes, measurementUnits] = await Promise.all([
    getStockOverview(supabase, restaurantId, { includeInactive: showInactive }),
    authorize(userId, restaurantId, PERMISSIONS.STOCK_ADJUST),
    authorize(userId, restaurantId, PERMISSIONS.STOCK_RECEIVE),
    authorize(userId, restaurantId, PERMISSIONS.RECIPE_VIEW),
    getMeasurementUnitsForRestaurant(supabase, restaurantId),
  ])
  const receivedCount = params.received ? Number(params.received) : 0
  const successMessage =
    receivedCount > 0
      ? `Delivery recorded. ${receivedCount} items received. Stock updated.`
      : null

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Stock Management</h1>
          <p className="mt-1 text-sm text-[#6B675F]">
            Track inventory levels and record goods received.
          </p>
          <div className="mt-5">
            <StockSubNav showReceiveButton={canReceive} showRecipesTab={canViewRecipes} />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <StockOverviewPanel
          data={data}
          successMessage={successMessage}
          canAdjust={canAdjust}
          canManage={canReceive}
          showInactive={showInactive}
          measurementUnits={measurementUnits}
        />
      </div>
    </div>
  )
}
