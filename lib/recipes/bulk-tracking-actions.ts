'use server'

import { revalidatePath } from 'next/cache'
import { PERMISSIONS } from '@/lib/permissions'
import { requireRecipePermissionOrError } from '@/lib/recipes/auth'
import {
  buildTrackingAuditRows,
  planBulkTrackingChange,
  summarizeBulkTrackingResult,
  type TrackingCandidate,
} from '@/lib/recipes/bulk-tracking'

/**
 * Bulk menu_items.track_inventory changes.
 *
 * Kept out of lib/recipes/actions.ts on purpose: saveRecipeAction there force-sets
 * track_inventory = true (actions.ts:144-153), and these actions must never inherit that
 * behaviour. Nothing here writes recipes, recipe_items or stock_items.
 */

type AnyClient = { from: (table: string) => any }

/** PostgREST caps at 1000 rows; an unpaginated balance sum silently under-reports. */
async function pageAll(
  client: AnyClient,
  table: string,
  columns: string,
  apply: (q: any) => any,
): Promise<Array<Record<string, unknown>>> {
  const page = 1000
  const acc: Array<Record<string, unknown>> = []
  for (let from = 0; ; from += page) {
    const { data, error } = await apply(client.from(table).select(columns)).range(
      from,
      from + page - 1,
    )
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Array<Record<string, unknown>>
    acc.push(...rows)
    if (rows.length < page) return acc
  }
}

/**
 * Every menu item that could take part in a bulk change, with enough recipe and balance
 * context to predict what enabling it would refuse.
 *
 * "Live recipe" here means active AND not tombstoned. check_stock_sufficiency_locked does not
 * currently honour recipes.deleted_at while deduct_recipe_stock does; using the stricter
 * definition means the preview can over-warn but never under-warn.
 */
export async function loadTrackingCandidates(
  client: AnyClient,
  restaurantId: string,
): Promise<TrackingCandidate[]> {
  const [menuItems, recipes, stockItems] = await Promise.all([
    pageAll(client, 'menu_items', 'id, name, track_inventory, status', (q) =>
      q.eq('restaurant_id', restaurantId).neq('status', 'hidden').order('name')),
    pageAll(client, 'recipes', 'id, menu_item_id', (q) =>
      q.eq('restaurant_id', restaurantId).eq('is_active', true).is('deleted_at', null)),
    pageAll(client, 'stock_items', 'id, name', (q) => q.eq('restaurant_id', restaurantId)),
  ])

  const recipeIds = recipes.map((r) => String(r.id))
  const recipeItems = recipeIds.length
    ? await pageAll(client, 'recipe_items', 'recipe_id, stock_item_id, quantity', (q) =>
        q.in('recipe_id', recipeIds))
    : []

  const stockIds = [...new Set(recipeItems.map((ri) => String(ri.stock_item_id)))]
  const movements = stockIds.length
    ? await pageAll(client, 'stock_movements', 'stock_item_id, quantity_delta', (q) =>
        q.in('stock_item_id', stockIds))
    : []

  const balance = new Map<string, number>()
  for (const m of movements) {
    const k = String(m.stock_item_id)
    balance.set(k, (balance.get(k) ?? 0) + Number(m.quantity_delta || 0))
  }

  const stockName = new Map(stockItems.map((s) => [String(s.id), String(s.name)]))
  const recipeByMenuItem = new Map(recipes.map((r) => [String(r.menu_item_id), String(r.id)]))
  const linesByRecipe = new Map<string, Array<Record<string, unknown>>>()
  for (const ri of recipeItems) {
    const k = String(ri.recipe_id)
    if (!linesByRecipe.has(k)) linesByRecipe.set(k, [])
    linesByRecipe.get(k)!.push(ri)
  }

  return menuItems.map((m) => {
    const recipeId = recipeByMenuItem.get(String(m.id))
    const lines = recipeId ? (linesByRecipe.get(recipeId) ?? []) : []
    const balances = lines.map((l) => balance.get(String(l.stock_item_id)) ?? 0)
    return {
      menuItemId: String(m.id),
      name: String(m.name),
      tracked: m.track_inventory === true,
      hasLiveRecipe: lines.length > 0,
      lowestIngredientBalance: balances.length ? Math.min(...balances) : null,
      blockingIngredients: lines
        .filter((l) => (balance.get(String(l.stock_item_id)) ?? 0) <= 0)
        .map((l) => stockName.get(String(l.stock_item_id)) ?? 'unknown ingredient'),
    }
  })
}

/**
 * READ-ONLY preview. Reveals nothing a RECIPE_VIEW holder cannot already see, so it is gated
 * one level below the write.
 */
export async function previewBulkTrackingAction(input: {
  selectedIds: string[]
  target: boolean
}) {
  const context = await requireRecipePermissionOrError(PERMISSIONS.RECIPE_VIEW)
  if ('error' in context) return { error: context.error }

  try {
    const candidates = await loadTrackingCandidates(
      context.supabase as unknown as AnyClient,
      context.restaurantId,
    )
    const plan = planBulkTrackingChange({
      candidates,
      selectedIds: input.selectedIds ?? [],
      target: Boolean(input.target),
    })
    return { data: { ...plan, allCandidates: candidates } }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to preview tracking change.' }
  }
}

/**
 * Applies a bulk track_inventory change. Writes menu_items.track_inventory and audit_logs only.
 *
 * `confirmBlocking` is required to ENABLE tracking on items that would be refused immediately.
 * Turning tracking OFF never requires it — off cannot refuse an order.
 */
export async function bulkSetTrackInventoryAction(input: {
  selectedIds: string[]
  target: boolean
  confirmBlocking?: boolean
}) {
  const context = await requireRecipePermissionOrError(PERMISSIONS.RECIPE_EDIT)
  if ('error' in context) return { error: context.error }

  const { restaurantId, userId } = context
  const target = Boolean(input.target)

  try {
    const candidates = await loadTrackingCandidates(
      context.supabase as unknown as AnyClient,
      restaurantId,
    )
    const plan = planBulkTrackingChange({
      candidates,
      selectedIds: input.selectedIds ?? [],
      target,
    })

    if (plan.toChange.length === 0) {
      return {
        data: {
          batchId: null,
          changed: [],
          alreadyInState: plan.alreadyInState,
          unknownIds: plan.unknownIds,
          lostRace: [],
          wouldBlockImmediately: [],
          message: summarizeBulkTrackingResult({
            target,
            changed: [],
            alreadyInState: plan.alreadyInState,
          }),
        },
      }
    }

    if (target && plan.wouldBlockImmediately.length > 0 && !input.confirmBlocking) {
      return {
        error:
          `${plan.wouldBlockImmediately.length} item(s) would stop accepting orders immediately ` +
          `because an ingredient is at or below zero: ` +
          `${plan.wouldBlockImmediately.map((c) => c.name).join(', ')}. ` +
          `Count those ingredients first, or confirm to enable anyway.`,
        needsConfirmation: true,
        wouldBlockImmediately: plan.wouldBlockImmediately,
      }
    }

    // menu_items mutations are revoked from `authenticated` (migration 20260705200000);
    // staff writes go through service_role. RECIPE_EDIT is already established above and the
    // write is scoped to this restaurant.
    const { createServerSupabaseClient } = await import('@/lib/supabase/server')
    const admin = createServerSupabaseClient()

    const ids = plan.toChange.map((c) => c.menuItemId)
    const { data: updated, error: updateError } = await admin
      .from('menu_items')
      .update({ track_inventory: target })
      .eq('restaurant_id', restaurantId)
      .in('id', ids)
      // Re-assert the pre-state: a concurrent per-item toggle wins the race instead of being
      // clobbered, and a second identical run matches zero rows.
      .eq('track_inventory', !target)
      .select('id, name')

    if (updateError) return { error: updateError.message }

    const changedIds = new Set((updated ?? []).map((r) => String(r.id)))
    const changed = plan.toChange.filter((c) => changedIds.has(c.menuItemId))
    const lostRace = plan.toChange.filter((c) => !changedIds.has(c.menuItemId))

    const batchId = `bulk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    if (changed.length > 0) {
      const { error: auditError } = await admin
        .from('audit_logs')
        .insert(buildTrackingAuditRows({ restaurantId, userId, batchId, target, changed }))
      if (auditError) {
        // The tracking change already committed — surface the gap rather than hide it.
        console.error('[bulkSetTrackInventory] audit insert failed:', auditError.message)
      }
    }

    revalidatePath('/stock')
    revalidatePath('/menu-management')

    return {
      data: {
        batchId,
        changed,
        alreadyInState: plan.alreadyInState,
        unknownIds: plan.unknownIds,
        lostRace,
        wouldBlockImmediately: target ? plan.wouldBlockImmediately : [],
        message: summarizeBulkTrackingResult({ target, changed, alreadyInState: plan.alreadyInState }),
      },
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to change tracking.' }
  }
}
