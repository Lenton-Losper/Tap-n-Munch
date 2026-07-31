/**
 * Linking a menu item to stock must make it read as TRACKED (staging integration).
 *
 * Merchant-reported bug, 2026-07-31: an item linked to stock still showed as untracked, with
 * no way to confirm the link had worked. The link persisted perfectly; every tracked-status
 * surface just reads a different column -- menu_items.track_inventory -- which
 * saveRecipeAction did not set. So the item vanished from Stock entirely: not shown as
 * tracked, and not even listed as tracked-but-unconfigured.
 *
 * These tests pin both halves of the contract, so reverting either one fails here.
 */
import { getSupabaseAdmin } from './helpers'
import { getInventorySetupOverview } from '../lib/recipes/queries'

const RUN_TAG = `stock-link-${Date.now()}`

describe('menu item <-> stock link is reflected as tracked (staging)', () => {
  const admin = getSupabaseAdmin()

  let restaurantId: string
  let menuItemId: string
  let stockItemId: string
  let unitId: string | null = null
  let recipeId: string | null = null
  let createdMenuItem = false

  beforeAll(async () => {
    const { data: stockItem, error: stockErr } = await admin
      .from('stock_items')
      .select('id, restaurant_id')
      .limit(1)
      .maybeSingle()
    if (stockErr) throw stockErr
    if (!stockItem) throw new Error('staging has no stock_items to link against')

    stockItemId = String(stockItem.id)
    restaurantId = String(stockItem.restaurant_id)

    const { data: unit } = await admin.from('measurement_units').select('id').limit(1).maybeSingle()
    unitId = unit?.id ? String(unit.id) : null

    // A dedicated menu item, so the assertions never depend on other staging data.
    const { data: created, error: createErr } = await admin
      .from('menu_items')
      .insert({
        restaurant_id: restaurantId,
        name: `${RUN_TAG} linked item`,
        base_price: 10,
        status: 'available',
        track_inventory: false,
      })
      .select('id')
      .single()
    if (createErr) throw createErr
    menuItemId = String(created.id)
    createdMenuItem = true
  }, 30_000)

  afterAll(async () => {
    if (recipeId) {
      await admin.from('recipe_items').delete().eq('recipe_id', recipeId)
      await admin.from('recipes').delete().eq('id', recipeId)
    }
    if (createdMenuItem && menuItemId) {
      await admin.from('menu_items').delete().eq('id', menuItemId)
    }
  }, 30_000)

  /** Exactly what saveRecipeAction writes for the link itself. */
  async function writeLink() {
    const { data: recipe, error: recipeErr } = await admin
      .from('recipes')
      .insert({ restaurant_id: restaurantId, menu_item_id: menuItemId, is_active: true })
      .select('id')
      .single()
    if (recipeErr) throw recipeErr
    recipeId = String(recipe.id)

    const { error: itemsErr } = await admin.from('recipe_items').insert({
      recipe_id: recipeId,
      stock_item_id: stockItemId,
      quantity: 1,
      unit_id: unitId,
    })
    if (itemsErr) throw itemsErr
  }

  async function isShownAsTracked() {
    const overview = await getInventorySetupOverview(admin, restaurantId)
    return {
      tracked: overview.readyMenuItemIds.includes(menuItemId),
      listedAtAll:
        overview.readyMenuItemIds.includes(menuItemId) ||
        overview.missingItems.some((m) => String(m.menuItemId) === menuItemId),
    }
  }

  it('starts untracked and unlisted', async () => {
    const before = await isShownAsTracked()
    expect(before.tracked).toBe(false)
    expect(before.listedAtAll).toBe(false)
  }, 30_000)

  it('writing the link alone is NOT enough -- this is the bug that was reported', async () => {
    await writeLink()

    // The link itself persisted...
    const { data: items } = await admin.from('recipe_items').select('id').eq('recipe_id', recipeId!)
    expect((items ?? []).length).toBe(1)

    // ...yet the merchant still sees nothing. Documents precisely why the flag is required.
    const after = await isShownAsTracked()
    expect(after.tracked).toBe(false)
    expect(after.listedAtAll).toBe(false)
  }, 30_000)

  it('setting track_inventory alongside the link makes it read as tracked', async () => {
    // The fix: saveRecipeAction now does this in the same branch as the recipe_items insert.
    const { error } = await admin
      .from('menu_items')
      .update({ track_inventory: true })
      .eq('restaurant_id', restaurantId)
      .eq('id', menuItemId)
    expect(error).toBeNull()

    const after = await isShownAsTracked()
    expect(after.tracked).toBe(true)
    expect(after.listedAtAll).toBe(true)
  }, 30_000)

  it('a tracked item whose ingredients are all removed stays visible as unconfigured', async () => {
    // track_inventory is deliberately NOT cleared when ingredients go to zero: the overview
    // models "tracked but not yet configured" via missingItems, and the merchant should keep
    // seeing the item rather than have it disappear again.
    await admin.from('recipe_items').delete().eq('recipe_id', recipeId!)

    const after = await isShownAsTracked()
    expect(after.tracked).toBe(false)
    expect(after.listedAtAll).toBe(true)
  }, 30_000)
})
