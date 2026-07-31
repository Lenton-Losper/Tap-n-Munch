/**
 * READ-ONLY diagnosis of the reported Redbull case (PRODUCTION).
 *
 * Reported: "Redbull" / "Redbull zero 250ml" show green "Inventory Ready" on Menu Management,
 * while their Stock counterparts "Red Bull 250ml" / "Redbul zero 250ml" show "NOT TRACKED".
 *
 * Two hypotheses to separate with evidence:
 *   H1  stale pre-fix data -- the link predates the deploy of the track_inventory fix, so it
 *       would come right on a re-save.
 *   H2  something structural -- e.g. links resolved by NAME, in which case "Redbull" vs
 *       "Red Bull 250ml" would silently fail to match.
 *
 * And a third possibility neither of those covers, which the code suggests is the real one:
 *   H3  the two screens do not mean the same thing by "tracked". Menu Management's badge is
 *       driven by menu_items.track_inventory + a recipe with >=1 ingredient. The Stock page's
 *       status comes from computeStockStatus(currentStock, par_level), which returns
 *       'not_tracked' whenever par_level IS NULL -- entirely unrelated to any menu link.
 *
 *   npx tsx --env-file=.env.local scripts/diagnose-redbull-tracking-20260731.ts
 */
import { createClient } from '@supabase/supabase-js'
import { computeStockStatus } from '../lib/stock/format'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url || !serviceKey) throw new Error('Missing production Supabase URL / service role key')
if (!/ihlmmpmolnpchzgwyhgh/.test(url)) throw new Error(`Expected production, got ${url}`)

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

// The track_inventory fix went live with this deploy.
const FIX_DEPLOYED_AT = '2026-07-31T15:35:00.000Z'

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main() {
  console.log('=== READ-ONLY -- production -- NO WRITES ===')

  const { data: menuItems } = await admin
    .from('menu_items')
    .select('id, name, restaurant_id, track_inventory, status, created_at, updated_at')
    .ilike('name', '%redbul%')

  const { data: stockItems } = await admin
    .from('stock_items')
    .select('id, name, restaurant_id, par_level, unit_id, is_active, created_at, updated_at')
    .ilike('name', '%red%bul%')

  const { data: restaurants } = await admin.from('restaurants').select('id, name')
  const rName = new Map((restaurants ?? []).map((r) => [r.id, r.name]))

  log('MENU ITEMS matching "redbul"', (menuItems ?? []).map((m) => ({
    id: m.id, name: m.name, restaurant: rName.get(m.restaurant_id),
    track_inventory: m.track_inventory, status: m.status,
  })))

  log('STOCK ITEMS matching "red*bul"', (stockItems ?? []).map((s) => ({
    id: s.id, name: s.name, restaurant: rName.get(s.restaurant_id),
    par_level: s.par_level, is_active: s.is_active,
  })))

  // --- how is each menu item actually linked? ---
  const findings: Array<Record<string, unknown>> = []
  for (const m of menuItems ?? []) {
    const { data: recipe } = await admin
      .from('recipes')
      .select('id, is_active, created_at, updated_at')
      .eq('restaurant_id', m.restaurant_id)
      .eq('menu_item_id', m.id)
      .maybeSingle()

    let ingredients: Array<Record<string, unknown>> = []
    if (recipe?.id) {
      const { data: items } = await admin
        .from('recipe_items')
        .select('id, stock_item_id, quantity, unit_id')
        .eq('recipe_id', recipe.id)
      for (const ri of items ?? []) {
        const { data: si } = await admin
          .from('stock_items')
          .select('id, name, par_level')
          .eq('id', ri.stock_item_id)
          .maybeSingle()
        ingredients.push({
          recipe_item_id: ri.id,
          stock_item_id: ri.stock_item_id,
          resolved_stock_item_name: si?.name ?? '(stock item not found)',
          links_by: 'stock_item_id (uuid FK)',
          name_matches_menu_item: si?.name === m.name,
          stock_item_par_level: si?.par_level ?? null,
        })
      }
    }

    // Balance, so the Stock page status can be computed exactly as the UI does.
    const stockStatuses: Array<Record<string, unknown>> = []
    for (const ing of ingredients) {
      const { data: mv } = await admin
        .from('stock_movements')
        .select('quantity_delta')
        .eq('stock_item_id', String(ing.stock_item_id))
      const balance = (mv ?? []).reduce((s, r) => s + Number(r.quantity_delta), 0)
      stockStatuses.push({
        stock_item: ing.resolved_stock_item_name,
        balance,
        par_level: ing.stock_item_par_level,
        stock_page_status: computeStockStatus(balance, ing.stock_item_par_level as number | null),
      })
    }

    findings.push({
      menu_item: m.name,
      restaurant: rName.get(m.restaurant_id),
      menu_management_shows:
        m.track_inventory && recipe?.is_active && ingredients.length >= 1
          ? 'Inventory Ready'
          : m.track_inventory
            ? 'Inventory Missing'
            : '(no badge -- track_inventory is false)',
      track_inventory: m.track_inventory,
      recipe_id: recipe?.id ?? null,
      recipe_active: recipe?.is_active ?? null,
      recipe_created_at: recipe?.created_at ?? null,
      link_predates_fix: recipe?.created_at
        ? new Date(String(recipe.created_at)) < new Date(FIX_DEPLOYED_AT)
        : null,
      ingredients,
      what_the_stock_page_shows: stockStatuses,
    })
  }

  log('PER MENU ITEM', findings)

  // --- is any of this name-based? ---
  log('LINK MECHANISM', {
    recipe_items_columns_used: ['recipe_id', 'stock_item_id (uuid)', 'quantity', 'unit_id'],
    resolution: 'recipe_items.stock_item_id is a uuid foreign key to stock_items.id',
    name_used_anywhere_in_linking: false,
    conclusion:
      'Linking is by stable id. Differing display names ("Redbull" vs "Red Bull 250ml") cannot '
      + 'break a link, and cannot silently fail to match.',
  })

  // --- what does the Stock page actually key "NOT TRACKED" off? ---
  log('STOCK PAGE "NOT TRACKED" MEANING', {
    source: 'lib/stock/format.ts computeStockStatus(currentStock, parLevel)',
    rule: "returns 'not_tracked' whenever par_level IS NULL, regardless of any menu link",
    par_levels: (stockItems ?? []).map((s) => ({ name: s.name, par_level: s.par_level })),
  })
}

main().catch((e) => { console.error(e); process.exit(1) })
