'use client'

import { MenuManagementV2 as MenuManagement } from '@/components/menu-management-v2'
import type { InventorySetupData } from '@/lib/recipes/queries'

type MenuManagementPageContentProps = {
  initialInventorySetup: InventorySetupData | null
  missingInventoryFilter: boolean
}

export function MenuManagementPageContent({
  initialInventorySetup,
  missingInventoryFilter,
}: MenuManagementPageContentProps) {
  return (
    <MenuManagement
      initialInventorySetup={initialInventorySetup}
      missingInventoryFilter={missingInventoryFilter}
    />
  )
}
