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
  if (!setup) {
    return null
  }

  // Tracking is off, but the recipe is still live and still deducting on every sale.
  // Previously this rendered nothing at all, so the item looked identical to one that had
  // never been linked -- while its stock quietly drained. Say what is actually happening.
  //
  // This is a state a merchant can reach deliberately, by unticking "Track inventory" and
  // keeping the recipe, and there is no way in the UI to remove a link once made. But
  // "paused" would be a lie: deduct_recipe_stock ignores track_inventory entirely, so sales
  // still reduce stock. The label says linked-not-tracked; the tooltip says the part that
  // actually costs money.
  if (!item.track_inventory) {
    if (!setup.linkedButUntrackedIds.includes(item.id)) {
      return null
    }
    return (
      <span
        title="Tracking is off for this item, but it is still linked to a stock item and sales continue to deduct stock. Turn tracking back on, or remove the ingredients, to stop this."
        className="inline-flex items-center rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800"
      >
        🔴 Linked · not tracked
      </span>
    )
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
