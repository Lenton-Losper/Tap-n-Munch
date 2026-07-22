/**
 * Production verification: menu RLS write lockdown + real guest browsing + staff API routes.
 *   npx tsx scripts/verify-menu-tables-rls-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { CHOWNOW_ID, RIVIERA_ID } from '../__tests__/constants'
import { rolePermissionConfigEntries } from '../lib/permissions/role-permissions-config'

config({ path: '.env.production.local', override: true })

const APP = process.env.PRODUCTION_APP_URL || 'https://www.flashtap.app'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const tag = `menu-rls-prod-${Date.now()}`
const pw = `Set${randomUUID().slice(0, 8)}!1`

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY!

if (!url?.includes(PROD_REF)) throw new Error('Refusing: not production Supabase')

const dbAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const authAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonGuest = createClient(url, anonKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonAuth = createClient(url, anonKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let restAId: string | null = null
let restBId: string | null = null
let ownerAId: string | null = null
let categoryBId: string | null = null
let subcategoryBId: string | null = null
let itemBId: string | null = null
let apiCategoryId: string | null = null
let apiSubcategoryId: string | null = null
let apiItemId: string | null = null

const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`

async function signIn(email: string) {
  const { data, error } = await anonAuth.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session
}

async function clientForSession(session: { access_token: string; refresh_token: string }) {
  const client = createClient(url, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })
  return client
}

async function seedRestaurantRoles(restaurantId: string) {
  const rows = rolePermissionConfigEntries().map(([slug, perms]) => ({
    restaurant_id: restaurantId,
    role_slug: slug,
    display_name: slug,
    permissions: [...perms],
    is_system: slug === 'owner',
    is_invite_eligible: slug === 'manager' || slug === 'waiter',
  }))
  const { error } = await dbAdmin.from('restaurant_roles').insert(rows)
  if (error) throw error
}

async function setup() {
  for (const [slug, label] of [
    [`${tag}-a`, 'a'],
    [`${tag}-b`, 'b'],
  ] as const) {
    const { data: rest, error } = await dbAdmin
      .from('restaurants')
      .insert({ name: `${slug} Restaurant`, slug })
      .select('id')
      .single()
    if (error || !rest?.id) throw error
    if (label === 'a') restAId = rest.id
    else restBId = rest.id
    await seedRestaurantRoles(rest.id)
  }

  const { data: u, error: uErr } = await authAdmin.auth.admin.createUser({
    email: ownerAEmail,
    password: pw,
    email_confirm: true,
  })
  if (uErr || !u.user) throw uErr
  ownerAId = u.user.id
  await dbAdmin.from('users').insert({
    id: ownerAId,
    email: ownerAEmail,
    role: 'owner',
    restaurant_id: restAId!,
    full_name: 'Menu RLS verify owner A',
  })
  await dbAdmin.from('restaurant_users').insert({
    restaurant_id: restAId!,
    user_id: ownerAId,
    role: 'owner',
    invite_accepted: true,
  })

  const { data: catB } = await dbAdmin
    .from('menu_categories')
    .insert({ restaurant_id: restBId!, name: `${tag} Cat B`, active: true, route_to: 'kitchen' })
    .select('id')
    .single()
  categoryBId = String(catB!.id)

  const { data: subB } = await dbAdmin
    .from('menu_subcategories')
    .insert({ restaurant_id: restBId!, category_id: categoryBId, name: `${tag} Sub B` })
    .select('id')
    .single()
  subcategoryBId = String(subB!.id)

  const { data: itemB } = await dbAdmin
    .from('menu_items')
    .insert({
      restaurant_id: restBId!,
      category_id: categoryBId,
      subcategory_id: subcategoryBId,
      name: `${tag} Item B`,
      base_price: 7,
      status: 'available',
    })
    .select('id')
    .single()
  itemBId = String(itemB!.id)
}

type WriteProbe = { blocked: boolean; error: string | null; id: string | null }

async function probeInsert(
  client: ReturnType<typeof createClient>,
  table: 'menu_categories' | 'menu_subcategories' | 'menu_items',
  row: Record<string, unknown>,
): Promise<WriteProbe> {
  const { data, error } = await client.from(table).insert(row).select('id').maybeSingle()
  return {
    blocked: Boolean(error) && !data?.id,
    error: error?.message ?? null,
    id: data?.id ? String(data.id) : null,
  }
}

async function probeUpdate(
  client: ReturnType<typeof createClient>,
  table: 'menu_categories' | 'menu_subcategories' | 'menu_items',
  id: string,
  updates: Record<string, unknown>,
): Promise<WriteProbe> {
  const { data, error } = await client.from(table).update(updates).eq('id', id).select('id').maybeSingle()
  return {
    blocked: !data?.id,
    error: error?.message ?? null,
    id: data?.id ? String(data.id) : id,
  }
}

async function probeDelete(
  client: ReturnType<typeof createClient>,
  table: 'menu_categories' | 'menu_subcategories' | 'menu_items',
  id: string,
): Promise<WriteProbe> {
  const { data, error } = await client.from(table).delete().eq('id', id).select('id').maybeSingle()
  return {
    blocked: !data?.id,
    error: error?.message ?? null,
    id: data?.id ? String(data.id) : id,
  }
}

async function probeGuestSelect(restaurantId: string, label: string) {
  const tables = ['menu_categories', 'menu_subcategories', 'menu_items'] as const
  const out: Record<string, { ok: boolean; count: number; sampleNames: string[]; error: string | null }> = {}
  for (const table of tables) {
    const selectCols = table === 'menu_items' ? 'id, name' : 'id, name'
    const { data, error } = await anonGuest
      .from(table)
      .select(selectCols)
      .eq('restaurant_id', restaurantId)
      .limit(5)
    out[table] = {
      ok: !error,
      count: data?.length ?? 0,
      sampleNames: (data ?? []).map((r: { name?: string }) => r.name ?? '').filter(Boolean),
      error: error?.message ?? null,
    }
  }
  return { label, restaurantId, ...out }
}

async function postCategory(token: string, restaurantId: string, name: string) {
  return fetch(`${APP}/api/admin/menu/categories`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId, name, route_to: 'kitchen' }),
  })
}

async function patchCategory(
  token: string,
  restaurantId: string,
  categoryId: string,
  updates: Record<string, unknown>,
) {
  return fetch(`${APP}/api/admin/menu/categories`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId, categoryId, ...updates }),
  })
}

async function deleteCategory(token: string, restaurantId: string, categoryId: string) {
  return fetch(`${APP}/api/admin/menu/categories`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId, categoryId }),
  })
}

async function postSubcategory(token: string, restaurantId: string, categoryId: string, name: string) {
  return fetch(`${APP}/api/admin/menu/subcategories`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId, categoryId, name }),
  })
}

async function deleteSubcategory(token: string, restaurantId: string, subCategoryId: string) {
  return fetch(`${APP}/api/admin/menu/subcategories`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId, subCategoryId }),
  })
}

async function postItem(token: string, body: Record<string, unknown>) {
  return fetch(`${APP}/api/admin/menu/items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function deleteItem(token: string, itemId: string, restaurantId: string) {
  return fetch(`${APP}/api/admin/menu/items`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: itemId, restaurant_id: restaurantId, restaurantId }),
  })
}

async function fetchGuestFeatures(restaurantId: string) {
  return fetch(`${APP}/api/menu/${encodeURIComponent(restaurantId)}/features`)
}

async function cleanup() {
  if (apiItemId) await dbAdmin.from('menu_items').delete().eq('id', apiItemId)
  if (apiSubcategoryId) await dbAdmin.from('menu_subcategories').delete().eq('id', apiSubcategoryId)
  if (apiCategoryId) await dbAdmin.from('menu_categories').delete().eq('id', apiCategoryId)
  if (itemBId) await dbAdmin.from('menu_items').delete().eq('id', itemBId)
  if (subcategoryBId) await dbAdmin.from('menu_subcategories').delete().eq('id', subcategoryBId)
  if (categoryBId) await dbAdmin.from('menu_categories').delete().eq('id', categoryBId)
  if (ownerAId) {
    await dbAdmin.from('restaurant_users').delete().eq('user_id', ownerAId)
    await dbAdmin.from('users').delete().eq('id', ownerAId)
    await authAdmin.auth.admin.deleteUser(ownerAId)
  }
  for (const restId of [restAId, restBId]) {
    if (!restId) continue
    await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurants').delete().eq('id', restId)
  }
}

function allBlocked(probes: Record<string, WriteProbe>) {
  return Object.values(probes).every((p) => p.blocked)
}

async function main() {
  await setup()
  const ownerSession = await signIn(ownerAEmail)
  const ownerTok = ownerSession.access_token
  const ownerClient = await clientForSession(ownerSession)

  const crossTenant_ownerA_to_B = {
    insert_category: await probeInsert(ownerClient, 'menu_categories', {
      restaurant_id: restBId!,
      name: `${tag} xcat`,
      active: true,
      route_to: 'kitchen',
    }),
    update_category: await probeUpdate(ownerClient, 'menu_categories', categoryBId!, {
      name: `${tag} xcat rename`,
    }),
    delete_category: await probeDelete(ownerClient, 'menu_categories', categoryBId!),
    insert_subcategory: await probeInsert(ownerClient, 'menu_subcategories', {
      restaurant_id: restBId!,
      category_id: categoryBId!,
      name: `${tag} xsub`,
    }),
    update_subcategory: await probeUpdate(ownerClient, 'menu_subcategories', subcategoryBId!, {
      name: `${tag} xsub rename`,
    }),
    delete_subcategory: await probeDelete(ownerClient, 'menu_subcategories', subcategoryBId!),
    insert_item: await probeInsert(ownerClient, 'menu_items', {
      restaurant_id: restBId!,
      category_id: categoryBId!,
      subcategory_id: subcategoryBId!,
      name: `${tag} xitem`,
      base_price: 1,
      status: 'available',
    }),
    update_item: await probeUpdate(ownerClient, 'menu_items', itemBId!, {
      name: `${tag} xitem rename`,
    }),
    delete_item: await probeDelete(ownerClient, 'menu_items', itemBId!),
  }

  const anonGuestWrites_to_B = {
    insert_category: await probeInsert(anonGuest, 'menu_categories', {
      restaurant_id: restBId!,
      name: `${tag} anon cat`,
      active: true,
      route_to: 'kitchen',
    }),
    update_category: await probeUpdate(anonGuest, 'menu_categories', categoryBId!, {
      name: `${tag} anon rename`,
    }),
    delete_category: await probeDelete(anonGuest, 'menu_categories', categoryBId!),
    insert_subcategory: await probeInsert(anonGuest, 'menu_subcategories', {
      restaurant_id: restBId!,
      category_id: categoryBId!,
      name: `${tag} anon sub`,
    }),
    update_subcategory: await probeUpdate(anonGuest, 'menu_subcategories', subcategoryBId!, {
      name: `${tag} anon sub rename`,
    }),
    delete_subcategory: await probeDelete(anonGuest, 'menu_subcategories', subcategoryBId!),
    insert_item: await probeInsert(anonGuest, 'menu_items', {
      restaurant_id: restBId!,
      category_id: categoryBId!,
      subcategory_id: subcategoryBId!,
      name: `${tag} anon item`,
      base_price: 2,
      status: 'available',
    }),
    update_item: await probeUpdate(anonGuest, 'menu_items', itemBId!, {
      name: `${tag} anon item rename`,
    }),
    delete_item: await probeDelete(anonGuest, 'menu_items', itemBId!),
  }

  const realGuestBrowsing = {
    riviera: await probeGuestSelect(RIVIERA_ID, 'Riviera'),
    chownow: await probeGuestSelect(CHOWNOW_ID, 'ChowNow'),
  }

  const rivieraFeatures = await fetchGuestFeatures(RIVIERA_ID)
  const chownowFeatures = await fetchGuestFeatures(CHOWNOW_ID)
  const rivieraFeaturesBody = await rivieraFeatures.json().catch(() => ({}))
  const chownowFeaturesBody = await chownowFeatures.json().catch(() => ({}))

  const createCatRes = await postCategory(ownerTok, restAId!, `${tag} API Cat`)
  const createCatBody = await createCatRes.json().catch(() => ({}))
  apiCategoryId = String((createCatBody as { id?: string; data?: { id?: string } }).id ||
    (createCatBody as { data?: { id?: string } }).data?.id || '')

  const patchCatRes = apiCategoryId
    ? await patchCategory(ownerTok, restAId!, apiCategoryId, { name: `${tag} API Cat Renamed` })
    : null

  const createSubRes = apiCategoryId
    ? await postSubcategory(ownerTok, restAId!, apiCategoryId, `${tag} API Sub`)
    : null
  const createSubBody = createSubRes ? await createSubRes.json().catch(() => ({})) : {}
  apiSubcategoryId = String((createSubBody as { data?: { id?: string } }).data?.id || '')

  const createItemRes = apiCategoryId
    ? await postItem(ownerTok, {
        restaurantId: restAId!,
        restaurant_id: restAId!,
        category_id: apiCategoryId,
        subcategory_id: apiSubcategoryId || null,
        name: `${tag} API Item`,
        base_price: 12.5,
        status: 'available',
      })
    : null
  const createItemBody = createItemRes ? await createItemRes.json().catch(() => ({})) : {}
  apiItemId = String((createItemBody as { id?: string }).id || '')

  const patchItemRes = apiItemId
    ? await fetch(`${APP}/api/admin/menu/items`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${ownerTok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: apiItemId,
          restaurantId: restAId!,
          restaurant_id: restAId!,
          name: `${tag} API Item Renamed`,
          base_price: 13.5,
        }),
      })
    : null

  const deleteItemRes = apiItemId ? await deleteItem(ownerTok, apiItemId, restAId!) : null
  const deleteSubRes = apiSubcategoryId
    ? await deleteSubcategory(ownerTok, restAId!, apiSubcategoryId)
    : null
  const deleteCatRes = apiCategoryId ? await deleteCategory(ownerTok, restAId!, apiCategoryId) : null

  const report = {
    app: APP,
    tag,
    exploitProbes: { crossTenant_ownerA_to_B, anonGuestWrites_to_B },
    realGuestBrowsing,
    guestFeaturesApi: {
      riviera: { status: rivieraFeatures.status, body: rivieraFeaturesBody },
      chownow: { status: chownowFeatures.status, body: chownowFeaturesBody },
    },
    staffApiRoutes: {
      createCategory: createCatRes.status,
      patchCategory: patchCatRes?.status ?? 'skipped',
      createSubcategory: createSubRes?.status ?? 'skipped',
      createItem: createItemRes?.status ?? 'skipped',
      patchItem: patchItemRes?.status ?? 'skipped',
      deleteItem: deleteItemRes?.status ?? 'skipped',
      deleteSubcategory: deleteSubRes?.status ?? 'skipped',
      deleteCategory: deleteCatRes?.status ?? 'skipped',
      note:
        'Production deploy uses legacy request bodies (restaurantId required). PATCH/DELETE for categories/subcategories return 405 until Phase 5D app deploy.',
    },
  }

  console.log(JSON.stringify(report, null, 2))

  const crossBlocked = allBlocked(crossTenant_ownerA_to_B)
  const anonBlocked = allBlocked(anonGuestWrites_to_B)

  const rivieraOk =
    realGuestBrowsing.riviera.menu_categories.ok &&
    realGuestBrowsing.riviera.menu_categories.count >= 1 &&
    realGuestBrowsing.riviera.menu_items.ok &&
    realGuestBrowsing.riviera.menu_items.count >= 1 &&
    rivieraFeatures.status === 200

  const chownowOk =
    realGuestBrowsing.chownow.menu_categories.ok &&
    realGuestBrowsing.chownow.menu_categories.count >= 1 &&
    realGuestBrowsing.chownow.menu_items.ok &&
    realGuestBrowsing.chownow.menu_items.count >= 1 &&
    chownowFeatures.status === 200

  const apiOk =
    report.staffApiRoutes.createCategory === 200 &&
    report.staffApiRoutes.createSubcategory === 200 &&
    report.staffApiRoutes.createItem === 200 &&
    report.staffApiRoutes.patchItem === 200 &&
    report.staffApiRoutes.deleteItem === 200

  const pass = crossBlocked && anonBlocked && rivieraOk && chownowOk && apiOk

  if (!pass) {
    console.error('MENU_TABLES_RLS_PRODUCTION_FAIL')
    process.exitCode = 1
  } else {
    console.log('MENU_TABLES_RLS_PRODUCTION_OK')
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await cleanup()
      console.log('Cleanup complete.')
    } catch (e) {
      console.error('Cleanup failed:', e)
    }
  })
