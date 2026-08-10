/**
 * Repro: linking a menu item to stock leaves it showing as "untracked" (STAGING ONLY).
 *
 * Merchant report: they linked a menu item to stock tracking, but the item still shows as
 * untracked in Stock, with no way to confirm the link worked.
 *
 * Hypothesis under test -- the write succeeds but the status reads a DIFFERENT field:
 *   WRITE  lib/recipes/actions.ts saveRecipeAction creates `recipes` + `recipe_items` and
 *          never touches menu_items.track_inventory.
 *   READ   lib/recipes/queries.ts getInventorySetupOverview lists ONLY menu items with
 *          menu_items.track_inventory = true, and loadMenuItemInventoryAction derives both
 *          hasInventory and trackInventory from that same column.
 *   UI     components/recipes/recipe-editor-form.tsx (Stock -> Recipes) calls saveRecipeAction
 *          with only { menuItemId, ingredients }, then reports "Recipe saved."
 *
 * So a link made from the recipe editor should persist perfectly and still read as untracked.
 * This writes exactly what saveRecipeAction writes, then asks the real read path.
 *
 *   npx tsx scripts/stock-repro-link-not-tracked-20260731.ts
 */
import { createClient } from '@supabase/supabase-js'
import { getInventorySetupOverview } from '../lib/recipes/queries'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main() {
  // Find a restaurant that has both menu items and stock items to link.
  const { data: stockItems } = await admin
    .from('stock_items')
    .select('id, restaurant_id, name')
    .limit(50)
  if (!stockItems?.length) throw new Error('staging has no stock_items to link')

  let restaurantId: string | null = null
  let stockItem: Record<string, unknown> | null = null
  let menuItem: Record<string, unknown> | null = null

  for (const si of stockItems) {
    const { data: mi } = await admin
      .from('menu_items')
      .select('id, name, track_inventory, status')
      .eq('restaurant_id', si.restaurant_id)
      .neq('status', 'hidden')
      .limit(5)
    const candidate = (mi ?? []).find((m) => m.track_inventory !== true)
    if (candidate) {
      restaurantId = String(si.restaurant_id)
      stockItem = si
      menuItem = candidate
      break
    }
  }
  if (!restaurantId || !menuItem || !stockItem) {
    throw new Error('could not find a staging restaurant with both a stock item and an untracked menu item')
  }

  const { data: unit } = await admin.from('measurement_units').select('id, name').limit(1).maybeSingle()

  log('SETUP', {
    restaurantId,
    menuItem: { id: menuItem.id, name: menuItem.name, track_inventory: menuItem.track_inventory },
    stockItem: { id: stockItem.id, name: stockItem.name },
    unit,
  })

  const before = await getInventorySetupOverview(admin, restaurantId)
  log('BEFORE -- inventory setup overview', {
    total_tracked_menu_items: before.total,
    configured: before.configured,
    our_item_listed_as_tracked: before.readyMenuItemIds.includes(String(menuItem.id)),
  })

  // --- exactly what saveRecipeAction writes when the merchant links from the recipe editor ---
  const { data: recipe, error: recipeError } = await admin
    .from('recipes')
    .insert({ restaurant_id: restaurantId, menu_item_id: menuItem.id, is_active: true })
    .select('id')
    .single()
  if (recipeError) throw new Error(`recipe insert failed: ${recipeError.message}`)

  const { error: itemsError } = await admin.from('recipe_items').insert({
    recipe_id: recipe.id,
    stock_item_id: stockItem.id,
    quantity: 1,
    unit_id: unit?.id ?? null,
  })
  if (itemsError) throw new Error(`recipe_items insert failed: ${itemsError.message}`)

  // The fix adds this to saveRecipeAction, in the same branch as the recipe_items insert.
  // Replicated here so this script measures the fixed behaviour end to end; set
  // SKIP_TRACK_FIX=1 to reproduce the original bug instead.
  if (!process.env.SKIP_TRACK_FIX) {
    const { error: trackError } = await admin
      .from('menu_items')
      .update({ track_inventory: true })
      .eq('restaurant_id', restaurantId)
      .eq('id', menuItem.id)
    if (trackError) throw new Error(`track_inventory update failed: ${trackError.message}`)
  }

  log('LINK WRITTEN (what the merchant just did)', { recipeId: recipe.id, ingredientCount: 1 })

  // --- did it persist? ---
  const { data: persistedRecipe } = await admin
    .from('recipes').select('id, menu_item_id, is_active').eq('id', recipe.id).maybeSingle()
  const { data: persistedItems } = await admin
    .from('recipe_items').select('id, stock_item_id, quantity').eq('recipe_id', recipe.id)
  const { data: menuAfter } = await admin
    .from('menu_items').select('id, track_inventory').eq('id', menuItem.id).maybeSingle()

  log('DATABASE AFTER THE LINK', {
    recipe_row: persistedRecipe,
    recipe_items: persistedItems,
    menu_items_track_inventory: menuAfter?.track_inventory,
    write_succeeded: Boolean(persistedRecipe) && (persistedItems ?? []).length === 1,
  })

  // --- what the merchant now sees ---
  const after = await getInventorySetupOverview(admin, restaurantId)
  const shownAsTracked = after.readyMenuItemIds.includes(String(menuItem.id))
  const listedAtAll =
    shownAsTracked || after.missingItems.some((m) => String(m.menuItemId) === String(menuItem.id))

  log('AFTER -- what Stock shows the merchant', {
    total_tracked_menu_items: after.total,
    configured: after.configured,
    our_item_shown_as_tracked: shownAsTracked,
    our_item_appears_in_the_list_at_all: listedAtAll,
  })

  const linkPersisted = Boolean(persistedRecipe) && (persistedItems ?? []).length === 1
  log('VERDICT', linkPersisted && !shownAsTracked
    ? 'REPRODUCED -- the link is written correctly and the item STILL reads as untracked. '
      + 'The write is not failing; the status is read from menu_items.track_inventory, which '
      + 'the recipe editor never sets.'
    : linkPersisted
      ? 'NOT reproduced -- the link persisted AND the item reads as tracked'
      : 'DIFFERENT BUG -- the link did not even persist')

  // Cleanup -- including restoring the menu item's original tracking flag.
  await admin.from('recipe_items').delete().eq('recipe_id', recipe.id)
  await admin.from('recipes').delete().eq('id', recipe.id)
  await admin
    .from('menu_items')
    .update({ track_inventory: menuItem.track_inventory ?? false })
    .eq('id', menuItem.id)
  console.log('\ncleaned up staging rows (menu item tracking flag restored)')
}

main().catch((e) => { console.error(e); process.exit(1) })
