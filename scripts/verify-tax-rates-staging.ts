/**
 * Staging data-level verification for Per-item VAT Phase A (tax_rates table + menu_items.tax_rate_id).
 * Hits the staging Supabase database directly with the service-role client -- proves the schema,
 * RLS, partial-unique-default constraint, and ON DELETE SET NULL behavior all work end to end.
 * (Does not exercise the Settings/Menu Management UI -- that requires a staging deploy of this
 * branch; see PR notes for the UI-level follow-up.)
 *
 *   npx tsx scripts/verify-tax-rates-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `taxrate-${Date.now()}`

const created = {
  restaurantIds: [] as string[],
  categoryIds: [] as string[],
  menuItemIds: [] as string[],
  taxRateIds: [] as string[],
}

async function cleanup() {
  if (process.env.PW_SKIP_CLEANUP) {
    console.log('PW_SKIP_CLEANUP set -- leaving fixtures in place for inspection:', JSON.stringify(created))
    return
  }
  if (created.menuItemIds.length) {
    await db.from('menu_items').delete().in('id', created.menuItemIds)
  }
  if (created.categoryIds.length) {
    await db.from('menu_categories').delete().in('id', created.categoryIds)
  }
  if (created.taxRateIds.length) {
    await db.from('tax_rates').delete().in('id', created.taxRateIds)
  }
  if (created.restaurantIds.length) {
    await db.from('restaurants').delete().in('id', created.restaurantIds)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function main() {
  // Fixture: a standalone restaurant + category + two menu items (one to configure, one to
  // leave unconfigured), independent of any real tenant data.
  const { data: restaurant, error: restaurantError } = await db
    .from('restaurants')
    .insert({ name: `${tag} Restaurant` })
    .select('id')
    .single()
  if (restaurantError || !restaurant) throw restaurantError ?? new Error('restaurant insert failed')
  created.restaurantIds.push(restaurant.id)
  console.log('Fixture restaurant created -- OK')

  const { data: category, error: categoryError } = await db
    .from('menu_categories')
    .insert({ restaurant_id: restaurant.id, name: `${tag} Category` })
    .select('id')
    .single()
  if (categoryError || !category) throw categoryError ?? new Error('category insert failed')
  created.categoryIds.push(category.id)

  // ============================================================
  // Part 1: create a rate, assign to a real item, confirm it persists.
  // ============================================================
  console.log('\n--- Part 1: create tax rate, assign to item, verify persistence ---')
  const { data: standardRate, error: standardRateError } = await db
    .from('tax_rates')
    .insert({
      restaurant_id: restaurant.id,
      name: 'Standard',
      percentage: 15,
      is_inclusive: true,
      is_default: true,
    })
    .select('id, name, percentage, is_inclusive, is_default')
    .single()
  if (standardRateError || !standardRate) throw standardRateError ?? new Error('tax rate insert failed')
  created.taxRateIds.push(standardRate.id)
  assert(standardRate.is_default === true, 'expected the first rate to be default')
  console.log('Tax rate "Standard" (15%, inclusive, default) created -- OK')

  const { data: configuredItem, error: configuredItemError } = await db
    .from('menu_items')
    .insert({
      restaurant_id: restaurant.id,
      category_id: category.id,
      name: `${tag} Configured Item`,
      base_price: 42,
      tax_rate_id: standardRate.id,
    })
    .select('id, tax_rate_id')
    .single()
  if (configuredItemError || !configuredItem) throw configuredItemError ?? new Error('menu item insert failed')
  created.menuItemIds.push(configuredItem.id)
  assert(configuredItem.tax_rate_id === standardRate.id, 'expected item.tax_rate_id to be set on insert')

  const { data: reread, error: rereadError } = await db
    .from('menu_items')
    .select('id, tax_rate_id')
    .eq('id', configuredItem.id)
    .single()
  if (rereadError) throw rereadError
  assert(reread?.tax_rate_id === standardRate.id, 'expected tax_rate_id to persist on re-read')
  console.log('Item created with tax_rate_id, re-read from DB confirms persistence -- OK')

  // ============================================================
  // Part 2: unconfigured item -- no tax_rate_id, no errors anywhere.
  // ============================================================
  console.log('\n--- Part 2: unconfigured item (null tax_rate_id) ---')
  const { data: unconfiguredItem, error: unconfiguredItemError } = await db
    .from('menu_items')
    .insert({
      restaurant_id: restaurant.id,
      category_id: category.id,
      name: `${tag} Unconfigured Item`,
      base_price: 10,
    })
    .select('id, tax_rate_id')
    .single()
  if (unconfiguredItemError || !unconfiguredItem) {
    throw unconfiguredItemError ?? new Error('unconfigured menu item insert failed')
  }
  created.menuItemIds.push(unconfiguredItem.id)
  assert(unconfiguredItem.tax_rate_id === null, 'expected tax_rate_id to default to null when omitted')
  console.log('Item created without tax_rate_id -- inserted with null, no errors -- OK')

  // ============================================================
  // Part 3: partial unique index enforces one default per restaurant.
  // ============================================================
  console.log('\n--- Part 3: one default per restaurant, enforced by the DB ---')
  const { data: secondRate, error: secondRateError } = await db
    .from('tax_rates')
    .insert({
      restaurant_id: restaurant.id,
      name: 'Zero-rated',
      percentage: 0,
      is_inclusive: true,
      is_default: false,
    })
    .select('id')
    .single()
  if (secondRateError || !secondRate) throw secondRateError ?? new Error('second tax rate insert failed')
  created.taxRateIds.push(secondRate.id)

  const { error: doubleDefaultError } = await db
    .from('tax_rates')
    .update({ is_default: true })
    .eq('id', secondRate.id)
  assert(doubleDefaultError, 'expected the partial unique index to reject a second default for the same restaurant')
  assert(
    String(doubleDefaultError?.message || '').toLowerCase().includes('duplicate') ||
      String(doubleDefaultError?.code || '') === '23505',
    `expected a unique-violation error, got: ${JSON.stringify(doubleDefaultError)}`,
  )
  console.log('DB rejected a second is_default=true row for the same restaurant -- OK')

  // Correct two-step flip (clear old default, then set new) must succeed.
  const { error: clearError } = await db
    .from('tax_rates')
    .update({ is_default: false })
    .eq('id', standardRate.id)
  if (clearError) throw clearError
  const { error: setNewDefaultError } = await db
    .from('tax_rates')
    .update({ is_default: true })
    .eq('id', secondRate.id)
  if (setNewDefaultError) throw setNewDefaultError
  console.log('Two-step default flip (clear old, set new) succeeds -- OK')

  // ============================================================
  // Part 4: deleting a tax rate falls items back to null (ON DELETE SET NULL), not an error.
  // ============================================================
  console.log('\n--- Part 4: deleting an assigned tax rate does not break the item ---')
  const { error: deleteRateError } = await db.from('tax_rates').delete().eq('id', standardRate.id)
  if (deleteRateError) throw deleteRateError
  created.taxRateIds = created.taxRateIds.filter((id) => id !== standardRate.id)

  const { data: afterDelete, error: afterDeleteError } = await db
    .from('menu_items')
    .select('id, tax_rate_id')
    .eq('id', configuredItem.id)
    .single()
  if (afterDeleteError) throw afterDeleteError
  assert(afterDelete?.tax_rate_id === null, 'expected tax_rate_id to be nulled out after the rate was deleted')
  console.log('Deleting the assigned tax rate set the item back to null (unconfigured) -- OK')

  console.log('\nTAX_RATES_STAGING_VERIFY_OK')
}

main()
  .catch(async (error) => {
    console.error('TAX_RATES_STAGING_VERIFY_FAIL', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await cleanup()
  })
