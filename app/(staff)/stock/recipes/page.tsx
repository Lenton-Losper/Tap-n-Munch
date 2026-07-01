export const dynamic = 'force-dynamic'

import { RecipesPanel } from '@/components/recipes/recipes-panel'
import { StockSubNav } from '@/components/stock/stock-sub-nav'
import { PERMISSIONS } from '@/lib/permissions'
import { authorize } from '@/lib/permissions/authorize'
import { requireRecipePermission } from '@/lib/recipes/auth'
import { getRecipesOverview } from '@/lib/recipes/queries'

export default async function RecipesPage() {
  const { supabase, userId, restaurantId } = await requireRecipePermission(PERMISSIONS.RECIPE_VIEW)
  const [data, canEdit, canReceive] = await Promise.all([
    getRecipesOverview(supabase, restaurantId),
    authorize(userId, restaurantId, PERMISSIONS.RECIPE_EDIT),
    authorize(userId, restaurantId, PERMISSIONS.STOCK_RECEIVE),
  ])

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Recipes</h1>
          <p className="mt-1 text-sm text-[#6B675F]">
            Define ingredient bills of materials for automatic stock deduction on sale.
          </p>
          <div className="mt-5">
            <StockSubNav showReceiveButton={canReceive} showRecipesTab />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <RecipesPanel data={data} canEdit={canEdit} />
      </div>
    </div>
  )
}
