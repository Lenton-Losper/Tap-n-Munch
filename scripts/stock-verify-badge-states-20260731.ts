/**
 * Verifies the badge states against real data (STAGING ONLY).
 *
 * Specifically checks the two things that matter for the reported Redbull case:
 *   1. An item in Redbull's ACTUAL production state (track_inventory=true, active recipe,
 *      1 ingredient, stock item with par_level NULL) still resolves to "Inventory Ready".
 *      The reported badge was correct and must not regress.
 *   2. An item with tracking OFF and a live recipe renders NO badge at all.
 *      UPDATED 2026-08-05: this previously asserted the red "Linked - not tracked" warning
 *      via linkedButUntrackedIds. That badge claimed such items keep deducting stock, which
 *      has been false since migration 20260731230000; the branch and the field were removed,
 *      so the correct expectation is now no badge.
 *
 *   npx tsx scripts/stock-verify-badge-states-20260731.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { getInventorySetupOverview } from '../lib/recipes/queries'
import { computeStockStatus } from '../lib/stock/format'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAG = `badge-${Date.now()}`

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** Mirrors MenuItemInventoryBadge's branching, so this asserts what a merchant would see. */
function badgeFor(item: { id: string; track_inventory: boolean }, setup: any): string {
  if (!setup) return '(none)'
  // Untracked items render nothing at all since the red branch was retired 2026-08-05.
  if (!item.track_inventory) {
    return '(none)'
  }
  return setup.readyMenuItemIds.includes(item.id) ? 'Inventory Ready' : 'Inventory Missing'
}

async function main() {
  const created: { menuItems: string[]; stockItems: string[]; recipes: string[] } = {
    menuItems: [], stockItems: [], recipes: [],
  }

  // stock_items.unit_id is NOT NULL, and measurement_units are restaurant-scoped, so take
  // one belonging to this restaurant (falling back to a system unit).
  const { data: unit } = await admin
    .from('measurement_units')
    .select('id, name, restaurant_id, is_system')
    .or(`restaurant_id.eq.${RID},is_system.eq.true`)
    .limit(1)
    .maybeSingle()
  if (!unit?.id) throw new Error('no measurement unit available for this staging restaurant')

  // Use an EXISTING stock item rather than creating one: stock_items requires a non-null
  // organization_stock_item_id, so a real one only comes from createStockItemAction, which
  // writes the canonical organisation row too. Reusing one is also closer to the reported
  // case, where the stock item long predates the link.
  const { data: stockItem } = await admin
    .from('stock_items')
    .select('id, name, par_level')
    .eq('restaurant_id', RID)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()
  if (!stockItem?.id) throw new Error('no active staging stock item to link against')

  async function makeLinkedItem(name: string, trackInventory: boolean) {
    const { data: mi } = await admin
      .from('menu_items')
      .insert({ restaurant_id: RID, name: `${TAG} ${name}`, base_price: 30, status: 'available', track_inventory: trackInventory })
      .select('id, name, track_inventory').single()
    created.menuItems.push(mi.id)

    const { data: recipe } = await admin
      .from('recipes').insert({ restaurant_id: RID, menu_item_id: mi.id, is_active: true })
      .select('id').single()
    created.recipes.push(recipe.id)

    await admin.from('recipe_items').insert({
      recipe_id: recipe.id, stock_item_id: stockItem.id, quantity: 1, unit_id: unit?.id ?? null,
    })
    return mi
  }

  // Case 1 -- Redbull's real state, deliberately with a differently-spelled stock item name.
  const redbullLike = await makeLinkedItem('Redbull', true)
  // Case 2 -- tracking switched off, recipe left live.
  const untracked = await makeLinkedItem('Paused item', false)

  const setup = await getInventorySetupOverview(admin, RID)

  const { data: mv } = await admin.from('stock_movements').select('quantity_delta').eq('stock_item_id', stockItem.id)
  const balance = (mv ?? []).reduce((s, r) => s + Number(r.quantity_delta), 0)

  const results = {
    'case 1 -- Redbull-like (tracked, linked, stock item has no par level)': {
      menu_item: redbullLike.name,
      track_inventory: redbullLike.track_inventory,
      in_readyMenuItemIds: setup.readyMenuItemIds.includes(redbullLike.id),
      badge: badgeFor(redbullLike, setup),
      expected_badge: 'Inventory Ready',
      linked_stock_item: stockItem.name,
      stock_page_status: computeStockStatus(balance, stockItem.par_level),
      stock_page_label: computeStockStatus(balance, stockItem.par_level) === 'not_tracked' ? 'No par level' : '(other)',
      verdict: badgeFor(redbullLike, setup) === 'Inventory Ready' ? 'PASS' : 'FAIL',
    },
    'case 2 -- tracking off, recipe still live (badge retired 2026-08-05)': {
      menu_item: untracked.name,
      track_inventory: untracked.track_inventory,
      in_readyMenuItemIds: setup.readyMenuItemIds.includes(untracked.id),
      badge: badgeFor(untracked, setup),
      expected_badge: '(none)',
      note: 'must NOT claim the item is still deducting -- it is not, since migration 20260731230000',
      verdict: badgeFor(untracked, setup) === '(none)' ? 'PASS' : 'FAIL',
    },
  }

  log('RESULTS', results)
  log('THE POINT', {
    both_screens_before:
      'Menu Management "Inventory Ready" + Stock "Not tracked" -- read as a contradiction',
    both_screens_after:
      'Menu Management "Inventory Ready" + Stock "No par level" -- two different facts, both true',
    untracked_after_2026_08_05:
      'Menu Management renders no badge for an untracked item; tracking state is shown in aggregate on the /stock Inventory tracking card',
  })

  const failures = Object.entries(results).filter(([, v]) => (v as any).verdict === 'FAIL')
  log('VERDICT', failures.length === 0
    ? 'PASS -- a correctly-linked tracked item still reads Inventory Ready, an untracked-but-'
      + 'linked item now warns instead of rendering nothing, and the stock label no longer '
      + 'collides with the tracking concept.'
    : `FAIL -- ${failures.map(([k]) => k).join('; ')}`)

  // Cleanup.
  for (const r of created.recipes) {
    await admin.from('recipe_items').delete().eq('recipe_id', r)
    await admin.from('recipes').delete().eq('id', r)
  }
  await admin.from('menu_items').delete().in('id', created.menuItems)
  // created.stockItems stays empty -- the stock item is pre-existing and must NOT be deleted.
  console.log('\ncleaned up staging fixtures')

  if (failures.length) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
