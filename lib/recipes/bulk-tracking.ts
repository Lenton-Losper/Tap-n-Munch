/**
 * Bulk menu_items.track_inventory changes.
 *
 * Why this exists: turning tracking off one item at a time is the only way to unblock a venue
 * whose balances have gone wrong, and it has been done by hand mid-service twice (15 items each
 * time) at Mingle Brew & Pour.
 *
 * Deliberate boundaries — this module writes to ONE column, `menu_items.track_inventory`:
 *  - It never touches `recipes`, `recipe_items` or `stock_items.is_active`. Turning tracking off
 *    must preserve the recipe exactly, the same way the item form does: its save path skips
 *    `saveRecipeAction` entirely when the toggle is off (menu-item-form-modal.tsx:516), so the
 *    ingredient rows survive untouched. The bulk path preserves them by simply never writing to
 *    those tables.
 *  - It never force-sets tracking true as a side effect, which `saveRecipeAction` does
 *    (actions.ts:144-153). That force-write is the reason the item form cannot express
 *    "correct the recipe while tracking stays off".
 *
 * The two directions are NOT symmetric and are deliberately modelled differently:
 *  - OFF can never refuse an order. Worst case, stock stops deducting and balances drift —
 *    recoverable with a physical count.
 *  - ON can refuse orders the instant it lands. `check_stock_sufficiency_locked` refuses any
 *    tracked item with an active recipe whose ingredient balance is <= 0. At Mingle on
 *    2026-08-05 that was 8 of 17 items, live, mid-service.
 * So ON requires a preview of exactly what would block; OFF does not.
 */

export type TrackingCandidate = {
  menuItemId: string
  name: string
  /** Current value of menu_items.track_inventory. */
  tracked: boolean
  /** Has an active, non-tombstoned recipe with at least one ingredient. */
  hasLiveRecipe: boolean
  /**
   * Lowest ingredient balance across the live recipe, or null when there is no live recipe.
   * Mirrors the gate's predicate input: it refuses at `balance <= 0`.
   */
  lowestIngredientBalance: number | null
  /** Ingredient names already at or below zero. */
  blockingIngredients: string[]
}

export type BulkTrackingPlan = {
  /** Rows that will actually be written. */
  toChange: TrackingCandidate[]
  /** Selected but already in the requested state — the idempotency bucket. */
  alreadyInState: TrackingCandidate[]
  /** Selected ids that do not belong to this restaurant, or do not exist. */
  unknownIds: string[]
  /**
   * Only populated when target === true. Items that would be refused by
   * check_stock_sufficiency_locked the moment tracking is enabled.
   */
  wouldBlockImmediately: TrackingCandidate[]
  /**
   * Only populated when target === true. Items with tracking on but no live recipe: harmless,
   * but they will not deduct either, so enabling them achieves nothing until a recipe exists.
   */
  noRecipeNoop: TrackingCandidate[]
}

/**
 * The gate's predicate, restated here so the preview cannot drift from it silently.
 *
 * `check_stock_sufficiency_locked` (20260801000000) refuses a menu item when it has an active
 * recipe, `menu_items.track_inventory IS TRUE`, and any ingredient's summed balance is <= 0.
 * Note it does NOT currently honour `recipes.deleted_at` while `deduct_recipe_stock` does; we
 * use the stricter "live recipe" definition here so the preview never under-reports a block.
 */
export function wouldBlockWhenTracked(candidate: TrackingCandidate): boolean {
  if (!candidate.hasLiveRecipe) return false
  if (candidate.lowestIngredientBalance === null) return false
  return candidate.lowestIngredientBalance <= 0
}

/**
 * Decide what a bulk change would do, without performing it.
 *
 * Idempotent by construction: an item already in the requested state lands in `alreadyInState`
 * and is never written, so running the same request twice changes nothing the second time.
 */
export function planBulkTrackingChange(params: {
  candidates: TrackingCandidate[]
  selectedIds: string[]
  target: boolean
}): BulkTrackingPlan {
  const byId = new Map(params.candidates.map((c) => [c.menuItemId, c]))
  const seen = new Set<string>()

  const toChange: TrackingCandidate[] = []
  const alreadyInState: TrackingCandidate[] = []
  const unknownIds: string[] = []

  for (const rawId of params.selectedIds) {
    const id = String(rawId ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)

    const candidate = byId.get(id)
    if (!candidate) {
      unknownIds.push(id)
      continue
    }
    if (candidate.tracked === params.target) {
      alreadyInState.push(candidate)
      continue
    }
    toChange.push(candidate)
  }

  const wouldBlockImmediately = params.target ? toChange.filter(wouldBlockWhenTracked) : []
  const noRecipeNoop = params.target ? toChange.filter((c) => !c.hasLiveRecipe) : []

  return { toChange, alreadyInState, unknownIds, wouldBlockImmediately, noRecipeNoop }
}

/** audit_logs.action written for every item a bulk run actually changes. */
export const BULK_TRACKING_AUDIT_ACTION = 'menu_item.track_inventory_changed'

/**
 * One audit row per changed item, sharing a batchId.
 *
 * Per-item rather than one row for the run, because `audit_logs` currently holds ZERO rows for
 * any menu or stock entity (measured 2026-08-05, all restaurants, all time) and
 * `stock_items.updated_at` never moves. Per-item rows make `entity_id` history work for the
 * first time; `batchId` keeps the run reconstructable as a single operator action.
 */
export function buildTrackingAuditRows(params: {
  restaurantId: string
  userId: string
  batchId: string
  target: boolean
  changed: TrackingCandidate[]
  source?: string
}): Array<Record<string, unknown>> {
  return params.changed.map((c) => ({
    restaurant_id: params.restaurantId,
    action: BULK_TRACKING_AUDIT_ACTION,
    entity_type: 'menu_item',
    entity_id: c.menuItemId,
    metadata: {
      batch_id: params.batchId,
      source: params.source ?? 'bulk_tracking_toggle',
      menu_item_name: c.name,
      from: !params.target,
      to: params.target,
      changed_by: params.userId,
      batch_size: params.changed.length,
      // Recorded so a later reader can tell whether enabling this item blocked it on the spot.
      had_live_recipe: c.hasLiveRecipe,
      lowest_ingredient_balance: c.lowestIngredientBalance,
      blocked_on_enable: params.target ? wouldBlockWhenTracked(c) : false,
      blocking_ingredients: params.target ? c.blockingIngredients : [],
    },
  }))
}

/** Human-readable summary for the toast / result panel. Never a silent success. */
export function summarizeBulkTrackingResult(params: {
  target: boolean
  changed: TrackingCandidate[]
  alreadyInState: TrackingCandidate[]
}): string {
  const verb = params.target ? 'Tracking enabled' : 'Tracking turned off'
  if (params.changed.length === 0) {
    return params.alreadyInState.length > 0
      ? `No changes — all ${params.alreadyInState.length} selected item(s) were already in that state.`
      : 'No changes — nothing was selected.'
  }
  const names = params.changed.map((c) => c.name).join(', ')
  const skipped =
    params.alreadyInState.length > 0
      ? ` ${params.alreadyInState.length} already in that state, left untouched.`
      : ''
  return `${verb} for ${params.changed.length} item(s): ${names}.${skipped}`
}
