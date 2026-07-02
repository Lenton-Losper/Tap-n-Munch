'use client'

import type { InventorySetupData } from '@/lib/recipes/queries'
import type { MenuItem } from '@/lib/supabase/menu'

export function MenuItemInventoryBadge({
  item,
  setup,
}: {
  item: MenuItem & { track_inventory?: boolean }
  setup: InventorySetupData | null
}) {
  if (!item.track_inventory || !setup) {
    return null
  }

  const isReady = setup.readyMenuItemIds.includes(item.id)

  if (isReady) {
    return (
      <span className="inline-flex items-center rounded-md border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800">
        🟢 Inventory Ready
      </span>
    )
  }

  return (
    <span className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
      🟠 Inventory Missing
    </span>
  )
}
