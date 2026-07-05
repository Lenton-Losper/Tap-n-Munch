export const dynamic = 'force-dynamic'

import { MenuManagementPageContent } from '@/components/menu-management/menu-management-page-content'
import { requireMenuPermission } from '@/lib/menu/auth'
import { PERMISSIONS } from '@/lib/permissions'
import { requireRecipePermissionOrError } from '@/lib/recipes/auth'
import { getInventorySetupOverview, type InventorySetupData } from '@/lib/recipes/queries'

type MenuManagementPageProps = {
  searchParams: Promise<{ missingInventory?: string }>
}

export default async function MenuManagementPage({ searchParams }: MenuManagementPageProps) {
  await requireMenuPermission(PERMISSIONS.MENU_READ)

  const params = await searchParams
  const missingInventoryFilter = params.missingInventory === 'true'

  let initialInventorySetup: InventorySetupData | null = null

  const context = await requireRecipePermissionOrError(PERMISSIONS.RECIPE_VIEW)
  if (!('error' in context)) {
    initialInventorySetup = await getInventorySetupOverview(context.supabase, context.restaurantId)
  }

  return (
    <MenuManagementPageContent
      initialInventorySetup={initialInventorySetup}
      missingInventoryFilter={missingInventoryFilter}
    />
  )
}
