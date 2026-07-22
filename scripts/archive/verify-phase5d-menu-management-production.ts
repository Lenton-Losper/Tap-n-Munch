/**
 * Phase 5D production verification: Menu Management permission migration.
 *   npx tsx scripts/verify-phase5d-menu-management-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { rolePermissionConfigEntries } from '../lib/permissions/role-permissions-config'
import { PERMISSIONS } from '../lib/permissions'
import { authorize } from '../lib/permissions/authorize'

config({ path: '.env.production.local', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const APP = process.env.PRODUCTION_APP_URL || 'https://www.flashtap.app'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const tag = `phase5d-prod-${Date.now()}`
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
let subcategoryAId: string | null = null
let subcategoryBId: string | null = null
let itemAId: string | null = null
let itemBId: string | null = null
let ownerCategoryId: string | null = null
let ownerSubcategoryId: string | null = null
let ownerItemId: string | null = null

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

  const { data: subA, error: subAErr } = await dbAdmin
    .from('menu_subcategories')
    .insert({
      restaurant_id: restAId!,
      category_id: categoryAId,
      name: `${tag} Sub A`,
    })
    .select('id')
    .single()
  if (subAErr || !subA?.id) throw subAErr
  subcategoryAId = String(subA.id)

  const { data: itemA, error: itemAErr } = await dbAdmin
    .from('menu_items')
    .insert({
      restaurant_id: restAId!,
      category_id: categoryAId,
      subcategory_id: subcategoryAId,
      name: `${tag} Item A`,
      base_price: 4.5,
      status: 'available',
    })
    .select('id')
    .single()
  if (itemAErr || !itemA?.id) throw itemAErr
  itemAId = String(itemA.id)

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
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, route_to: 'kitchen' }),
  })
}

async function patchCategory(token: string, categoryId: string, updates: Record<string, unknown>) {
  return fetch(`${APP}/api/admin/menu/categories`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ categoryId, ...updates }),
  })
}

async function deleteCategory(token: string, categoryId: string) {
  return fetch(`${APP}/api/admin/menu/categories`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ categoryId }),
  })
}

async function postSubcategory(token: string, categoryId: string, name: string) {
  return fetch(`${APP}/api/admin/menu/subcategories`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subCategoryId, categoryId, ...updates }),
  })
}

async function deleteSubcategory(token: string, subCategoryId: string) {
  return fetch(`${APP}/api/admin/menu/subcategories`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subCategoryId }),
  })
}

async function postItem(token: string, body: Record<string, unknown>) {
  return fetch(`${APP}/api/admin/menu/items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function patchItem(token: string, body: Record<string, unknown>) {
  return fetch(`${APP}/api/admin/menu/items`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function deleteItem(token: string, itemId: string, restaurantId: string) {
  return fetch(`${APP}/api/admin/menu/items`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
  if (ownerItemId) await dbAdmin.from('menu_items').delete().eq('id', ownerItemId)
  if (ownerSubcategoryId) await dbAdmin.from('menu_subcategories').delete().eq('id', ownerSubcategoryId)
  if (ownerCategoryId) await dbAdmin.from('menu_categories').delete().eq('id', ownerCategoryId)
  if (itemAId) await dbAdmin.from('menu_items').delete().eq('id', itemAId)
  if (itemBId) await dbAdmin.from('menu_items').delete().eq('id', itemBId)
  if (subcategoryAId) await dbAdmin.from('menu_subcategories').delete().eq('id', subcategoryAId)
  if (subcategoryBId) await dbAdmin.from('menu_subcategories').delete().eq('id', subcategoryBId)
  if (categoryAId) await dbAdmin.from('menu_categories').delete().eq('id', categoryAId)
  if (categoryBId) await dbAdmin.from('menu_categories').delete().eq('id', categoryBId)

  for (const uid of [ownerAId, managerAId, waiterAId, cashierAId, kitchenAId, barAId, ownerBId]) {
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
  const versionRes = await fetch(`${APP}/api/version`)
  const versionBody = await versionRes.json().catch(() => ({}))

  await setup()

  const ownerTok = await signIn(ownerAEmail)
  const managerTok = await signIn(managerAEmail)
  const waiterTok = await signIn(waiterAEmail)
  const cashierTok = await signIn(cashierAEmail)
  const kitchenTok = await signIn(kitchenAEmail)
  const barTok = await signIn(barAEmail)

  const ownerCreateCat = await postCategory(ownerTok, `${tag} Owner Cat`)
  const ownerCreateBody = await ownerCreateCat.json().catch(() => ({}))
  ownerCategoryId = String((ownerCreateBody as { id?: string; data?: { id?: string } }).id ||
    (ownerCreateBody as { data?: { id?: string } }).data?.id || '')

  const ownerCreateSub = ownerCategoryId
    ? await postSubcategory(ownerTok, ownerCategoryId, `${tag} Owner Sub`)
    : null
  const ownerSubBody = ownerCreateSub ? await ownerCreateSub.json().catch(() => ({})) : {}
  ownerSubcategoryId = String((ownerSubBody as { data?: { id?: string } }).data?.id || '')

  const ownerCreateItem = ownerCategoryId
    ? await postItem(ownerTok, {
        restaurant_id: restAId!,
        category_id: ownerCategoryId,
        subcategory_id: ownerSubcategoryId || null,
        name: `${tag} Owner Item`,
        base_price: 11,
        status: 'available',
      })
    : null
  const ownerItemBody = ownerCreateItem ? await ownerCreateItem.json().catch(() => ({})) : {}
  ownerItemId = String((ownerItemBody as { id?: string }).id || '')

  const report: Record<string, unknown> = {
    app: APP,
    tag,
    deployedVersion: versionBody,
    seedNote:
      'Only owner/manager have menu:read + menu:write in seed. Waiter/kitchen/cashier/bar have neither.',
  }

  report.ownerManager = {
    ownerMenuReadAuthorize: await authorize(ownerAId!, restAId!, PERMISSIONS.MENU_READ),
    ownerMenuWriteAuthorize: await authorize(ownerAId!, restAId!, PERMISSIONS.MENU_WRITE),
    managerMenuReadAuthorize: await authorize(managerAId!, restAId!, PERMISSIONS.MENU_READ),
    managerMenuWriteAuthorize: await authorize(managerAId!, restAId!, PERMISSIONS.MENU_WRITE),
    ownerPageProbe: await fetchMenuManagementPage(ownerTok),
    managerPageProbe: await fetchMenuManagementPage(managerTok),
    ownerCreateCategory: ownerCreateCat.status,
    managerCreateCategory: (await postCategory(managerTok, `${tag} Manager Cat`)).status,
    ownerPatchOwnSeedCategory: (await patchCategory(ownerTok, categoryAId!, { name: `${tag} Cat A Renamed` }))
      .status,
    ownerPatchCategory: ownerCategoryId
      ? (await patchCategory(ownerTok, ownerCategoryId, { name: `${tag} Owner Cat Renamed` })).status
      : 'skipped',
    ownerPatchSubcategory: ownerSubcategoryId
      ? (await patchSubcategory(ownerTok, ownerSubcategoryId, ownerCategoryId!, {
          name: `${tag} Owner Sub Renamed`,
        })).status
      : 'skipped',
    ownerPatchItem: ownerItemId
      ? (await patchItem(ownerTok, {
          id: ownerItemId,
          restaurant_id: restAId!,
          name: `${tag} Owner Item Renamed`,
          base_price: 12,
        })).status
      : 'skipped',
    ownerDeleteItem: ownerItemId
      ? (await deleteItem(ownerTok, ownerItemId, restAId!)).status
      : 'skipped',
    ownerDeleteSubcategory: ownerSubcategoryId
      ? (await deleteSubcategory(ownerTok, ownerSubcategoryId)).status
      : 'skipped',
    ownerDeleteCategory: ownerCategoryId
      ? (await deleteCategory(ownerTok, ownerCategoryId)).status
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
  }

  report.rlsClientBypass = {
    waiterDirectInsertCategoryOnB: await directClientMenuCategoryInsert(waiterAEmail, restBId!),
    ownerDirectInsertCategoryOnB: await directClientMenuCategoryInsert(ownerAEmail, restBId!),
  }

  console.log(JSON.stringify(report, null, 2))

  const owner = report.ownerManager as {
    ownerMenuReadAuthorize: boolean
    ownerMenuWriteAuthorize: boolean
    managerMenuReadAuthorize: boolean
    managerMenuWriteAuthorize: boolean
    ownerCreateCategory: number
    managerCreateCategory: number
    ownerPatchCategory: number | string
    ownerDeleteCategory: number | string
    ownerPatchSubcategory: number | string
    ownerDeleteSubcategory: number | string
    ownerPatchItem: number | string
    ownerDeleteItem: number | string
    ownerPatchOwnSeedCategory: number
  }
  const blocked = report.blockedRoles as {
    waiter: { menuRead: boolean; page: { denied: boolean }; createCategory: number }
    kitchen: { menuRead: boolean; page: { denied: boolean } }
    cashier: { menuRead: boolean; page: { denied: boolean } }
    bar: { menuRead: boolean; page: { denied: boolean } }
  }
  const cross = report.crossTenantWrites as Record<string, number>
  const rls = report.rlsClientBypass as {
    waiterDirectInsertCategoryOnB: { inserted: boolean }
    ownerDirectInsertCategoryOnB: { inserted: boolean }
  }

  const pass =
    owner.ownerMenuReadAuthorize &&
    owner.ownerMenuWriteAuthorize &&
    owner.managerMenuReadAuthorize &&
    owner.managerMenuWriteAuthorize &&
    owner.ownerCreateCategory === 200 &&
    owner.managerCreateCategory === 200 &&
    owner.ownerPatchCategory === 200 &&
    owner.ownerDeleteCategory === 200 &&
    owner.ownerPatchSubcategory === 200 &&
    owner.ownerDeleteSubcategory === 200 &&
    owner.ownerPatchItem === 200 &&
    owner.ownerDeleteItem === 200 &&
    owner.ownerPatchOwnSeedCategory === 200 &&
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
    !rls.waiterDirectInsertCategoryOnB.inserted &&
    !rls.ownerDirectInsertCategoryOnB.inserted

  if (!pass) {
    console.error('PHASE5D_PRODUCTION_FAIL')
    process.exitCode = 1
  } else {
    console.log('PHASE5D_PRODUCTION_OK')
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
