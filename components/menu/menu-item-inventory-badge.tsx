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

  // Tracking is off while the recipe is still live.
  //
  // STALE PREMISE, corrected 2026-08-05. This branch and its copy were written when
  // deduct_recipe_stock ignored track_inventory, so an untracked-but-linked item really did
  // keep draining stock. That has not been true since migration
  // 20260731230000_deduct_recipe_stock_honors_track_inventory; the current definition
  // (20260801010000_recipes_soft_delete.sql:81) gates on `m.track_inventory IS TRUE`, so an
  // untracked item does NOT deduct. Confirmed against the deployed
  // check_stock_sufficiency_locked by live control probe on 2026-08-05: "Beef Stew" at FNB
  // ChowNow, track_inventory=false with an ingredient at balance 0, is not refused.
  //
  // The badge label and tooltip below still assert the old behaviour and are therefore
  // misleading -- they are left unchanged here deliberately, because rewording merchant-facing
  // copy (or retiring this badge, whose whole premise is now false) is a product decision, not
  // a comment fix. See the 2026-08-05 stock discovery note.
  //
  // Still true and worth surfacing: there is no way in the UI to remove a link once made.
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
