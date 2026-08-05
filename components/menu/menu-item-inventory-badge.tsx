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

  // An untracked item gets no badge at all.
  //
  // RETIRED 2026-08-05: this used to render a red "🔴 Linked · not tracked" warning whose
  // tooltip said "sales continue to deduct stock". That was true when the branch was written
  // and has been false since migration 20260731230000_deduct_recipe_stock_honors_track_inventory
  // -- the current deduct_recipe_stock (20260801010000_recipes_soft_delete.sql:81) requires
  // `m.track_inventory IS TRUE`, so an untracked item does not deduct. Confirmed against the
  // deployed check_stock_sufficiency_locked by live control probe on 2026-08-05 ("Beef Stew"
  // at FNB ChowNow: track_inventory=false, ingredient balance 0, not refused).
  //
  // Removed rather than reworded to something neutral. Tracking-off is a state the merchant
  // chooses deliberately -- after a bulk turn-off it would badge every affected item at once,
  // which is noise precisely when it is least informative -- and it is not actionable from
  // this screen. The state worth surfacing, "tracked but not configured", is the amber badge
  // below. Aggregate tracking state belongs on the /stock Inventory tracking card.
  if (!item.track_inventory) {
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
