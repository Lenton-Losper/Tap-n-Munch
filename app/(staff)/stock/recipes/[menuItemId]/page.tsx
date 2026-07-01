export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { RecipeEditorForm } from '@/components/recipes/recipe-editor-form'
import { StockSubNav } from '@/components/stock/stock-sub-nav'
import { PERMISSIONS } from '@/lib/permissions'
import { authorize } from '@/lib/permissions/authorize'
import { requireRecipePermission } from '@/lib/recipes/auth'
import { getRecipeEditorData } from '@/lib/recipes/queries'
import { getActiveStockItems } from '@/lib/stock/queries'

type RecipeEditorPageProps = {
  params: Promise<{ menuItemId: string }>
}

export default async function RecipeEditorPage({ params }: RecipeEditorPageProps) {
  const { menuItemId } = await params
  const { supabase, userId, restaurantId } = await requireRecipePermission(PERMISSIONS.RECIPE_VIEW)
  const [editorData, stockItems, canEdit, canReceive] = await Promise.all([
    getRecipeEditorData(supabase, restaurantId, menuItemId),
    getActiveStockItems(supabase, restaurantId),
    authorize(userId, restaurantId, PERMISSIONS.RECIPE_EDIT),
    authorize(userId, restaurantId, PERMISSIONS.STOCK_RECEIVE),
  ])

  if (!editorData) {
    notFound()
  }

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="font-serif text-3xl font-semibold text-[#37352F]">
                {canEdit ? 'Edit recipe' : 'View recipe'}
              </h1>
              <p className="mt-1 text-sm text-[#6B675F]">
                Ingredients consumed when this menu item is sold.
              </p>
            </div>
            <Link
              href="/stock/recipes"
              className="text-sm font-medium text-[#6B675F] hover:text-[#37352F]"
            >
              Back to recipes
            </Link>
          </div>
          <div className="mt-5">
            <StockSubNav showReceiveButton={canReceive} showRecipesTab />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <RecipeEditorForm data={editorData} stockItems={stockItems} canEdit={canEdit} />
      </div>
    </div>
  )
}
