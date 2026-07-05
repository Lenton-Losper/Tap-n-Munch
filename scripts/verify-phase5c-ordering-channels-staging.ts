/**
 * Phase 5C staging verification: Ordering Channels permission migration.
 *   npx tsx scripts/verify-phase5c-ordering-channels-staging.ts
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
const tag = `phase5c-${Date.now()}`
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
let tableBId: string | null = null

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

  const { data: tableB, error: tableErr } = await dbAdmin
    .from('restaurant_tables')
    .insert({
      restaurant_id: restBId!,
      table_number: 99,
      table_name: 'Table 99',
      qr_code_url: `https://example.invalid/menu/${restBId}/99`,
      active: true,
    })
    .select('id')
    .single()
  if (tableErr || !tableB?.id) throw tableErr
  tableBId = String(tableB.id)

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
      full_name: `Phase5C ${label}`,
    })
    await dbAdmin.from('restaurant_users').insert({
      restaurant_id: restId,
      user_id: u.user.id,
      role,
      invite_accepted: true,
    })
  }
}

async function fetchOrderingChannelsPage(token: string) {
  const res = await fetch(`${APP}/qr-codes`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  })
  const body = await res.text()
  const denied =
    body.includes('NEXT_REDIRECT') &&
    (body.includes('/dashboard') || body.includes('/signin'))
  return { status: res.status, denied, location: res.headers.get('location') }
}

async function createTable(token: string, tableNumber: number) {
  return fetch(`${APP}/api/admin/tables`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ kind: 'table', table_number: tableNumber }),
  })
}

async function patchTable(
  token: string,
  tableId: string,
  restaurantId: string,
  updates: Record<string, unknown>,
) {
  return fetch(`${APP}/api/admin/tables/${encodeURIComponent(tableId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...updates, restaurantId }),
  })
}

async function deleteTable(token: string, tableId: string, restaurantId: string) {
  return fetch(`${APP}/api/admin/tables/${encodeURIComponent(tableId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ restaurantId }),
  })
}

async function queryRlsState() {
  const { data, error } = await dbAdmin
    .from('restaurant_tables')
    .select('id')
    .limit(1)
  return { serviceRoleSelectOk: !error && Array.isArray(data), error: error?.message ?? null }
}

async function crossTenantClientRead(email: string, foreignRestaurantId: string) {
  const { data, error: signErr } = await anon.auth.signInWithPassword({ email, password: pw })
  if (signErr || !data.session) {
    return { error: signErr?.message ?? 'sign-in failed', rowCount: 0, sampleRestaurantIds: [] }
  }

  const userClient = createClient(url, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  await userClient.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  })

  const { data: rows, error } = await userClient
    .from('restaurant_tables')
    .select('id, restaurant_id')
    .eq('restaurant_id', foreignRestaurantId)
    .limit(5)

  return {
    error: error?.message ?? null,
    rowCount: rows?.length ?? 0,
    sampleRestaurantIds: [...new Set((rows || []).map((r) => String(r.restaurant_id)))],
  }
}

async function cleanup() {
  if (tableBId) {
    await dbAdmin.from('restaurant_tables').delete().eq('id', tableBId)
  }
  for (const restId of [restAId, restBId]) {
    if (!restId) continue
    await dbAdmin.from('restaurant_tables').delete().eq('restaurant_id', restId)
  }
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
      'Waiter has tables:read + tables:manage in seed (expected expansion). Cashier has tables:read only (page access, writes blocked). Kitchen/bar lack tables:read.',
  }

  const ownerCreate = await createTable(ownerTok, 501)
  const ownerCreateBody = await ownerCreate.json().catch(() => ({}))
  let ownerTableId = String((ownerCreateBody as { table?: { id?: string } }).table?.id || '')

  report.ownerManager = {
    ownerPage: await fetchOrderingChannelsPage(ownerTok),
    managerPage: await fetchOrderingChannelsPage(managerTok),
    ownerCreate: ownerCreate.status,
    managerCreate: (await createTable(managerTok, 502)).status,
  }

  report.waiterExpansion = {
    readAuthorize: await authorize(waiterAId!, restAId!, PERMISSIONS.TABLES_READ),
    manageAuthorize: await authorize(waiterAId!, restAId!, PERMISSIONS.TABLES_MANAGE),
    page: await fetchOrderingChannelsPage(waiterTok),
    create: (await createTable(waiterTok, 503)).status,
    patch: ownerTableId
      ? (await patchTable(waiterTok, ownerTableId, restAId!, { location: 'Patio' })).status
      : 'skipped',
  }

  report.blockedRoles = {
    cashier: {
      readAuthorize: await authorize(cashierAId!, restAId!, PERMISSIONS.TABLES_READ),
      manageAuthorize: await authorize(cashierAId!, restAId!, PERMISSIONS.TABLES_MANAGE),
      page: await fetchOrderingChannelsPage(cashierTok),
      create: (await createTable(cashierTok, 504)).status,
    },
    kitchen: {
      readAuthorize: await authorize(kitchenAId!, restAId!, PERMISSIONS.TABLES_READ),
      page: await fetchOrderingChannelsPage(kitchenTok),
    },
    bar: {
      readAuthorize: await authorize(barAId!, restAId!, PERMISSIONS.TABLES_READ),
      page: await fetchOrderingChannelsPage(barTok),
    },
  }

  report.crossTenantWrites = {
    ownerACreateTableOnB: (
      await patchTable(ownerTok, tableBId!, restBId!, { location: 'Hijack' })
    ).status,
    ownerADeleteTableOnB: (await deleteTable(ownerTok, tableBId!, restBId!)).status,
    waiterACreateWithSpoofedBody: (
      await fetch(`${APP}/api/admin/tables`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${waiterTok}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'table',
          table_number: 505,
          restaurantId: restBId,
        }),
      })
    ).status,
  }

  report.rlsReCheck = {
    schemaExpectation:
      'restaurant_tables has a "Public can read tables" policy but RLS is not enabled in schema.sql — guest menu needs public reads; tenant isolation is not enforced at RLS layer.',
    directClientRead: await crossTenantClientRead(waiterAEmail, restBId!),
  }

  try {
    const { data: rlsFlag } = await dbAdmin
      .from('restaurant_tables')
      .select('id')
      .limit(1)
    report.rlsReCheck = {
      ...(report.rlsReCheck as object),
      serviceRoleSelectOk: Array.isArray(rlsFlag),
    }
  } catch {
    /* ignore */
  }

  if (ownerTableId) {
    await deleteTable(ownerTok, ownerTableId, restAId!).catch(() => {})
  }

  console.log(JSON.stringify(report, null, 2))

  const owner = report.ownerManager as {
    ownerCreate: number
    managerCreate: number
  }
  const waiter = report.waiterExpansion as {
    readAuthorize: boolean
    manageAuthorize: boolean
    create: number
    patch: number
  }
  const blocked = report.blockedRoles as {
    kitchen: { readAuthorize: boolean; page: { denied: boolean } }
    bar: { readAuthorize: boolean; page: { denied: boolean } }
    cashier: { manageAuthorize: boolean; create: number; readAuthorize: boolean }
  }
  const cross = report.crossTenantWrites as Record<string, number>

  const pass =
    owner.ownerCreate === 200 &&
    owner.managerCreate === 200 &&
    waiter.readAuthorize &&
    waiter.manageAuthorize &&
    waiter.create === 200 &&
    waiter.patch === 200 &&
    !blocked.kitchen.readAuthorize &&
    blocked.kitchen.page.denied &&
    !blocked.bar.readAuthorize &&
    blocked.bar.page.denied &&
    blocked.cashier.readAuthorize &&
    !blocked.cashier.manageAuthorize &&
    blocked.cashier.create === 403 &&
    cross.ownerACreateTableOnB === 403 &&
    cross.ownerADeleteTableOnB === 403 &&
    cross.waiterACreateWithSpoofedBody === 200

  if (!pass) {
    console.error('PHASE5C_STAGING_FAIL')
    process.exitCode = 1
  } else {
    console.log('PHASE5C_STAGING_OK')
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
