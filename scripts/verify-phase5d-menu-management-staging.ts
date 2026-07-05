/**
 * Phase 5D staging verification: Menu Management permission migration.
 *   npx tsx scripts/verify-phase5d-menu-management-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { rolePermissionConfigEntries } from '../lib/permissions/role-permissions-config'
import { PERMISSIONS } from '../lib/permissions'
import { authorize } from '../lib/permissions/authorize'

config({ path: '.env.test', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const tag = `phase5d-${Date.now()}`
const pw = `Set${randomUUID().slice(0, 8)}!1`

const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.SUPABASE_ANON_KEY!

if (!url?.includes(STAGING_REF)) throw new Error('Refusing: not staging Supabase')

const dbAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const authAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anon = createClient(url, anonKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let restAId: string | null = null
let restBId: string | null = null
let ownerAId: string | null = null
let managerAId: string | null = null
let waiterAId: string | null = null
let cashierAId: string | null = null
let kitchenAId: string | null = null
let barAId: string | null = null
let ownerBId: string | null = null
let categoryAId: string | null = null
let categoryBId: string | null = null
let subcategoryBId: string | null = null
let itemBId: string | null = null
let ownerCategoryId: string | null = null

const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`
const managerAEmail = `${tag}.manager-a@flashtap-test.invalid`
const waiterAEmail = `${tag}.waiter-a@flashtap-test.invalid`
const cashierAEmail = `${tag}.cashier-a@flashtap-test.invalid`
const kitchenAEmail = `${tag}.kitchen-a@flashtap-test.invalid`
const barAEmail = `${tag}.bar-a@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`

async function signIn(email: string) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session.access_token
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

  const { data: catA, error: catAErr } = await dbAdmin
    .from('menu_categories')
    .insert({
      restaurant_id: restAId!,
      name: `${tag} Cat A`,
      active: true,
      route_to: 'kitchen',
    })
    .select('id')
    .single()
  if (catAErr || !catA?.id) throw catAErr
  categoryAId = String(catA.id)

  const { data: catB, error: catBErr } = await dbAdmin
    .from('menu_categories')
    .insert({
      restaurant_id: restBId!,
      name: `${tag} Cat B`,
      active: true,
      route_to: 'kitchen',
    })
    .select('id')
    .single()
  if (catBErr || !catB?.id) throw catBErr
  categoryBId = String(catB.id)

  const { data: subB, error: subBErr } = await dbAdmin
    .from('menu_subcategories')
    .insert({
      restaurant_id: restBId!,
      category_id: categoryBId,
      name: `${tag} Sub B`,
    })
    .select('id')
    .single()
  if (subBErr || !subB?.id) throw subBErr
  subcategoryBId = String(subB.id)

  const { data: itemB, error: itemBErr } = await dbAdmin
    .from('menu_items')
    .insert({
      restaurant_id: restBId!,
      category_id: categoryBId,
      subcategory_id: subcategoryBId,
      name: `${tag} Item B`,
      base_price: 9.99,
      status: 'available',
    })
    .select('id')
    .single()
  if (itemBErr || !itemB?.id) throw itemBErr
  itemBId = String(itemB.id)

  const accounts = [
    [ownerAEmail, 'owner', 'ownerA'],
    [managerAEmail, 'manager', 'managerA'],
    [waiterAEmail, 'waiter', 'waiterA'],
    [cashierAEmail, 'cashier', 'cashierA'],
    [kitchenAEmail, 'kitchen', 'kitchenA'],
    [barAEmail, 'bar', 'barA'],
    [ownerBEmail, 'owner', 'ownerB'],
  ] as const

  for (const [email, role, label] of accounts) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error

    const restId = label === 'ownerB' ? restBId! : restAId!
    if (label === 'ownerA') ownerAId = u.user.id
    if (label === 'managerA') managerAId = u.user.id
    if (label === 'waiterA') waiterAId = u.user.id
    if (label === 'cashierA') cashierAId = u.user.id
    if (label === 'kitchenA') kitchenAId = u.user.id
    if (label === 'barA') barAId = u.user.id
    if (label === 'ownerB') ownerBId = u.user.id

    await dbAdmin.from('users').insert({
      id: u.user.id,
      email,
      role,
      restaurant_id: restId,
      full_name: `Phase5D ${label}`,
    })
    await dbAdmin.from('restaurant_users').insert({
      restaurant_id: restId,
      user_id: u.user.id,
      role,
      invite_accepted: true,
    })
  }
}

async function fetchMenuManagementPage(token: string) {
  const res = await fetch(`${APP}/menu-management`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  })
  const body = await res.text()
  const denied =
    body.includes('NEXT_REDIRECT') &&
    (body.includes('/dashboard') || body.includes('/signin'))
  return { status: res.status, denied, location: res.headers.get('location') }
}

async function postCategory(token: string, name: string) {
  return fetch(`${APP}/api/admin/menu/categories`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, route_to: 'kitchen' }),
  })
}

async function patchCategory(token: string, categoryId: string, updates: Record<string, unknown>) {
  return fetch(`${APP}/api/admin/menu/categories`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ categoryId, ...updates }),
  })
}

async function deleteCategory(token: string, categoryId: string) {
  return fetch(`${APP}/api/admin/menu/categories`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ categoryId }),
  })
}

async function postSubcategory(token: string, categoryId: string, name: string) {
  return fetch(`${APP}/api/admin/menu/subcategories`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ categoryId, name }),
  })
}

async function patchSubcategory(
  token: string,
  subCategoryId: string,
  categoryId: string,
  updates: Record<string, unknown>,
) {
  return fetch(`${APP}/api/admin/menu/subcategories`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ subCategoryId, categoryId, ...updates }),
  })
}

async function deleteSubcategory(token: string, subCategoryId: string) {
  return fetch(`${APP}/api/admin/menu/subcategories`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ subCategoryId }),
  })
}

async function deleteItem(token: string, itemId: string, restaurantId: string) {
  return fetch(`${APP}/api/admin/menu/items`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id: itemId, restaurant_id: restaurantId }),
  })
}

async function directClientMenuCategoryInsert(email: string, foreignRestaurantId: string) {
  const { data, error: signErr } = await anon.auth.signInWithPassword({ email, password: pw })
  if (signErr || !data.session) {
    return { error: signErr?.message ?? 'sign-in failed', inserted: false }
  }

  const userClient = createClient(url, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  await userClient.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  })

  const { data: row, error } = await userClient
    .from('menu_categories')
    .insert({
      restaurant_id: foreignRestaurantId,
      name: `${tag} bypass`,
      route_to: 'kitchen',
      active: true,
    })
    .select('id')
    .maybeSingle()

  return {
    error: error?.message ?? null,
    inserted: Boolean(row?.id),
    rowId: row?.id ? String(row.id) : null,
  }
}

async function cleanup() {
  if (ownerCategoryId) {
    await dbAdmin.from('menu_categories').delete().eq('id', ownerCategoryId)
  }
  if (itemBId) await dbAdmin.from('menu_items').delete().eq('id', itemBId)
  if (subcategoryBId) await dbAdmin.from('menu_subcategories').delete().eq('id', subcategoryBId)
  if (categoryBId) await dbAdmin.from('menu_categories').delete().eq('id', categoryBId)
  if (categoryAId) await dbAdmin.from('menu_categories').delete().eq('id', categoryAId)

  for (const uid of [
    ownerAId,
    managerAId,
    waiterAId,
    cashierAId,
    kitchenAId,
    barAId,
    ownerBId,
  ]) {
    if (!uid) continue
    await dbAdmin.from('restaurant_users').delete().eq('user_id', uid)
    await dbAdmin.from('users').delete().eq('id', uid)
    await authAdmin.auth.admin.deleteUser(uid)
  }
  for (const restId of [restAId, restBId]) {
    if (!restId) continue
    await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurants').delete().eq('id', restId)
  }
}

async function main() {
  await setup()

  const ownerTok = await signIn(ownerAEmail)
  const managerTok = await signIn(managerAEmail)
  const waiterTok = await signIn(waiterAEmail)
  const cashierTok = await signIn(cashierAEmail)
  const kitchenTok = await signIn(kitchenAEmail)
  const barTok = await signIn(barAEmail)

  const report: Record<string, unknown> = {
    app: APP,
    tag,
    seedNote:
      'Only owner/manager have menu:read + menu:write in seed. Waiter/kitchen/cashier/bar have neither — no access expansion expected.',
  }

  const ownerCreateCat = await postCategory(ownerTok, `${tag} Owner Cat`)
  const ownerCreateBody = await ownerCreateCat.json().catch(() => ({}))
  ownerCategoryId = String((ownerCreateBody as { id?: string; data?: { id?: string } }).id ||
    (ownerCreateBody as { data?: { id?: string } }).data?.id || '')

  report.ownerManager = {
    ownerPage: await fetchMenuManagementPage(ownerTok),
    managerPage: await fetchMenuManagementPage(managerTok),
    ownerCreateCategory: ownerCreateCat.status,
    managerCreateCategory: (await postCategory(managerTok, `${tag} Manager Cat`)).status,
    ownerPatchOwnCategory: ownerCategoryId
      ? (await patchCategory(ownerTok, categoryAId!, { name: `${tag} Cat A Renamed` })).status
      : 'skipped',
  }

  report.blockedRoles = {
    waiter: {
      menuRead: await authorize(waiterAId!, restAId!, PERMISSIONS.MENU_READ),
      menuWrite: await authorize(waiterAId!, restAId!, PERMISSIONS.MENU_WRITE),
      page: await fetchMenuManagementPage(waiterTok),
      createCategory: (await postCategory(waiterTok, `${tag} Waiter Cat`)).status,
    },
    kitchen: {
      menuRead: await authorize(kitchenAId!, restAId!, PERMISSIONS.MENU_READ),
      page: await fetchMenuManagementPage(kitchenTok),
    },
    cashier: {
      menuRead: await authorize(cashierAId!, restAId!, PERMISSIONS.MENU_READ),
      page: await fetchMenuManagementPage(cashierTok),
    },
    bar: {
      menuRead: await authorize(barAId!, restAId!, PERMISSIONS.MENU_READ),
      page: await fetchMenuManagementPage(barTok),
    },
  }

  report.crossTenantWrites = {
    ownerADeleteItemOnB: (await deleteItem(ownerTok, itemBId!, restBId!)).status,
    ownerAPatchCategoryOnB: (await patchCategory(ownerTok, categoryBId!, { name: 'Hijack' })).status,
    ownerADeleteCategoryOnB: (await deleteCategory(ownerTok, categoryBId!)).status,
    ownerAPostSubcategoryOnB: (await postSubcategory(ownerTok, categoryBId!, 'Hijack Sub')).status,
    ownerAPatchSubcategoryOnB: (
      await patchSubcategory(ownerTok, subcategoryBId!, categoryBId!, { name: 'Hijack Sub' })
    ).status,
    ownerADeleteSubcategoryOnB: (await deleteSubcategory(ownerTok, subcategoryBId!)).status,
    ownerADeleteItemOnBSpoofedRestaurantInBody: (
      await deleteItem(ownerTok, itemBId!, restBId!)
    ).status,
  }

  report.clientBypassProbe = {
    waiterDirectInsertCategoryOnB: await directClientMenuCategoryInsert(waiterAEmail, restBId!),
    ownerDirectInsertCategoryOnB: await directClientMenuCategoryInsert(ownerAEmail, restBId!),
  }

  console.log(JSON.stringify(report, null, 2))

  const owner = report.ownerManager as {
    ownerCreateCategory: number
    managerCreateCategory: number
    ownerPage: { denied: boolean }
    managerPage: { denied: boolean }
  }
  const blocked = report.blockedRoles as {
    waiter: { menuRead: boolean; page: { denied: boolean }; createCategory: number }
    kitchen: { menuRead: boolean; page: { denied: boolean } }
    cashier: { menuRead: boolean; page: { denied: boolean } }
    bar: { menuRead: boolean; page: { denied: boolean } }
  }
  const cross = report.crossTenantWrites as Record<string, number>
  const bypass = report.clientBypassProbe as {
    waiterDirectInsertCategoryOnB: { inserted: boolean }
    ownerDirectInsertCategoryOnB: { inserted: boolean }
  }

  const pass =
    !owner.ownerPage.denied &&
    !owner.managerPage.denied &&
    owner.ownerCreateCategory === 200 &&
    owner.managerCreateCategory === 200 &&
    !blocked.waiter.menuRead &&
    blocked.waiter.page.denied &&
    blocked.waiter.createCategory === 403 &&
    !blocked.kitchen.menuRead &&
    blocked.kitchen.page.denied &&
    !blocked.cashier.menuRead &&
    blocked.cashier.page.denied &&
    !blocked.bar.menuRead &&
    blocked.bar.page.denied &&
    cross.ownerADeleteItemOnB === 403 &&
    cross.ownerAPatchCategoryOnB === 403 &&
    cross.ownerADeleteCategoryOnB === 403 &&
    cross.ownerAPostSubcategoryOnB === 403 &&
    cross.ownerAPatchSubcategoryOnB === 403 &&
    cross.ownerADeleteSubcategoryOnB === 403 &&
    !bypass.waiterDirectInsertCategoryOnB.inserted &&
    !bypass.ownerDirectInsertCategoryOnB.inserted

  if (!pass) {
    console.error('PHASE5D_STAGING_FAIL')
    process.exitCode = 1
  } else {
    console.log('PHASE5D_STAGING_OK')
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
