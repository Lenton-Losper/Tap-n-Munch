/**
 * Verifies the client-privilege fix in saveRecipeAction (STAGING ONLY).
 *
 * My first attempt at the merchant fix did the track_inventory write on `context.supabase`,
 * which is user-scoped (role `authenticated`). Migration 20260705200000 deliberately revokes
 * INSERT/UPDATE/DELETE on menu_items from `authenticated` -- so that write failed with 42501
 * AFTER the recipe rows were already committed, turning a wrong-status bug into a partial
 * save. My original staging repro missed it because it used the service-role client
 * throughout, replicating what the fix writes instead of exercising the privilege the fix
 * actually runs under.
 *
 * This checks the thing that was wrong, with the two real client types:
 *   1. authenticated-role client UPDATE on menu_items  -> must be DENIED (the old bug)
 *   2. service-role client UPDATE on menu_items        -> must SUCCEED (the fix)
 *   3. the item then reads as tracked through the real read path
 *
 *   npx tsx scripts/stock-verify-track-inventory-grant-20260731.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { getInventorySetupOverview } from '../lib/recipes/queries'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const EMAIL = process.env.STAGING_TEST_EMAIL || 'staging.kitchen.test@gmail.com'
const PASSWORD = process.env.STAGING_TEST_PASSWORD || ''

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main() {
  // A throwaway menu item so nothing real is disturbed.
  const { data: item, error: createErr } = await admin
    .from('menu_items')
    .insert({
      restaurant_id: RESTAURANT,
      name: `grant-check-${Date.now()}`,
      base_price: 10,
      status: 'available',
      track_inventory: false,
    })
    .select('id, track_inventory')
    .single()
  if (createErr) throw new Error(`could not create fixture item: ${createErr.message}`)
  log('FIXTURE', item)

  try {
    // ---- 1. the client the broken fix used ----
    let authedResult: Record<string, unknown>
    if (!PASSWORD) {
      authedResult = { skipped: 'STAGING_TEST_PASSWORD not set; falling back to a bare anon client' }
    }
    const userClient = createClient(url, anonKey, { auth: { persistSession: false } })
    let signedInAs: string | null = null
    if (PASSWORD) {
      const { data: session, error: signInError } = await userClient.auth.signInWithPassword({
        email: EMAIL,
        password: PASSWORD,
      })
      if (signInError) {
        authedResult = { signInFailed: signInError.message }
      } else {
        signedInAs = session.user?.email ?? null
      }
    }

    const { error: authedError } = await userClient
      .from('menu_items')
      .update({ track_inventory: true })
      .eq('restaurant_id', RESTAURANT)
      .eq('id', item.id)

    const { data: afterAuthed } = await admin
      .from('menu_items').select('track_inventory').eq('id', item.id).maybeSingle()

    log('1. UPDATE as the user-scoped client (what the broken fix did)', {
      signed_in_as: signedInAs,
      role: signedInAs ? 'authenticated' : 'anon',
      error_code: (authedError as { code?: string } | null)?.code ?? null,
      error_message: authedError?.message ?? null,
      track_inventory_after: afterAuthed?.track_inventory,
      denied_as_expected: Boolean(authedError) || afterAuthed?.track_inventory !== true,
    })

    // ---- 2. the client the corrected fix uses ----
    const { error: serviceError } = await admin
      .from('menu_items')
      .update({ track_inventory: true })
      .eq('restaurant_id', RESTAURANT)
      .eq('id', item.id)

    const { data: afterService } = await admin
      .from('menu_items').select('track_inventory').eq('id', item.id).maybeSingle()

    log('2. UPDATE as the service-role client (the corrected fix)', {
      error: serviceError?.message ?? null,
      track_inventory_after: afterService?.track_inventory,
      succeeded: afterService?.track_inventory === true,
    })

    // ---- 3. does it now read as tracked? ----
    const { data: recipe } = await admin
      .from('recipes')
      .insert({ restaurant_id: RESTAURANT, menu_item_id: item.id, is_active: true })
      .select('id').single()
    const { data: stockItem } = await admin
      .from('stock_items').select('id').eq('restaurant_id', RESTAURANT).limit(1).maybeSingle()
    const { data: unit } = await admin.from('measurement_units').select('id').limit(1).maybeSingle()
    await admin.from('recipe_items').insert({
      recipe_id: recipe.id, stock_item_id: stockItem?.id, quantity: 1, unit_id: unit?.id ?? null,
    })

    const overview = await getInventorySetupOverview(admin, RESTAURANT)
    log('3. read path after the corrected fix', {
      shown_as_tracked: overview.readyMenuItemIds.includes(String(item.id)),
    })

    const deniedForUser = afterAuthed?.track_inventory !== true
    const allowedForService = afterService?.track_inventory === true
    const readsTracked = overview.readyMenuItemIds.includes(String(item.id))

    log('VERDICT', deniedForUser && allowedForService && readsTracked
      ? 'CONFIRMED -- the user-scoped client cannot make this write (which is why the first '
        + 'attempt failed after committing the recipe), the service-role client can, and the '
        + 'item then reads as tracked.'
      : `INCONCLUSIVE -- denied_for_user=${deniedForUser} allowed_for_service=${allowedForService} reads_tracked=${readsTracked}`)

    await admin.from('recipe_items').delete().eq('recipe_id', recipe.id)
    await admin.from('recipes').delete().eq('id', recipe.id)
  } finally {
    await admin.from('menu_items').delete().eq('id', item.id)
    console.log('\ncleaned up fixture item')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
