export const dynamic = 'force-dynamic'

import { MenuManagementV2 as MenuManagement } from '@/components/menu-management-v2'
import { RoleGuard } from '@/components/auth/role-guard'
import { PERMISSIONS } from '@/lib/permissions'
import { requireRecipePermissionOrError } from '@/lib/recipes/auth'
import { getInventorySetupOverview, type InventorySetupData } from '@/lib/recipes/queries'

type MenuManagementPageProps = {
  searchParams: Promise<{ missingInventory?: string }>
}

export default async function MenuManagementPage({ searchParams }: MenuManagementPageProps) {
  const params = await searchParams
  const missingInventoryFilter = params.missingInventory === 'true'

  let initialInventorySetup: InventorySetupData | null = null

  const context = await requireRecipePermissionOrError(PERMISSIONS.RECIPE_VIEW)
  if (!('error' in context)) {
    initialInventorySetup = await getInventorySetupOverview(context.supabase, context.restaurantId)
  }

  return (
    <RoleGuard allowedRoles={['owner', 'manager']}>
      <MenuManagement
        initialInventorySetup={initialInventorySetup}
        missingInventoryFilter={missingInventoryFilter}
      />
    </RoleGuard>
  )
}
