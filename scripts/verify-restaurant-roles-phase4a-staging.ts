/**
 * Phase 4A staging verification: composite FK + restaurant_roles CRUD API.
 *   npx tsx scripts/verify-restaurant-roles-phase4a-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import rolePermissionsConfig from '../lib/permissions/role-permissions.config.json'
import { PERMISSIONS } from '../lib/permissions'
import { authorize } from '../lib/permissions/authorize'

config({ path: '.env.test', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const tag = `roles4a-${Date.now()}`
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

const DISPLAY_NAMES: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  waiter: 'Waiter',
  kitchen: 'Kitchen',
  bar: 'Bar',
}

let restAId: string | null = null
let restBId: string | null = null
let ownerAId: string | null = null
let ownerBId: string | null = null
let disposableStaffId: string | null = null
let customRoleSlug: string | null = null

const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`

async function signIn(email: string) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session.access_token
}

async function seedRestaurantRoles(restaurantId: string) {
  const entries = Object.entries(rolePermissionsConfig).filter(([k]) => !k.startsWith('$'))
  const rows = entries.map(([slug, perms]) => ({
    restaurant_id: restaurantId,
    role_slug: slug,
    display_name: DISPLAY_NAMES[slug] ?? slug,
    permissions: perms as string[],
    is_system: slug === 'owner',
  }))
  const { error } = await dbAdmin.from('restaurant_roles').insert(rows)
  if (error) throw error
}

async function setup() {
  const { data: a } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} A`, slug: `${tag}-a` })
    .select('id')
    .single()
  restAId = a!.id

  const { data: b } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} B`, slug: `${tag}-b` })
    .select('id')
    .single()
  restBId = b!.id

  await seedRestaurantRoles(restAId!)
  await seedRestaurantRoles(restBId!)

  for (const [email, label] of [
    [ownerAEmail, 'ownerA'],
    [ownerBEmail, 'ownerB'],
  ] as const) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error
    if (label === 'ownerA') ownerAId = u.user.id
    if (label === 'ownerB') ownerBId = u.user.id
  }

  await dbAdmin.from('users').insert([
    { id: ownerAId, email: ownerAEmail, role: 'owner', restaurant_id: restAId, full_name: 'OA' },
    { id: ownerBId, email: ownerBEmail, role: 'owner', restaurant_id: restBId, full_name: 'OB' },
  ])

  await dbAdmin.from('restaurant_users').insert([
    { restaurant_id: restAId, user_id: ownerAId, role: 'owner', invite_accepted: true },
    { restaurant_id: restBId, user_id: ownerBId, role: 'owner', invite_accepted: true },
  ])
}

async function cleanup() {
  if (disposableStaffId) {
    await dbAdmin.from('staff_members').delete().eq('id', disposableStaffId)
    disposableStaffId = null
  }
  if (customRoleSlug && restAId) {
    await dbAdmin
      .from('restaurant_roles')
      .delete()
      .eq('restaurant_id', restAId)
      .eq('role_slug', customRoleSlug)
  }
  for (const rid of [restAId, restBId]) {
    if (rid) {
      await dbAdmin.from('staff_members').delete().eq('restaurant_id', rid)
      await dbAdmin.from('staff_invites').delete().eq('restaurant_id', rid)
      await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', rid)
      await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', rid)
      await dbAdmin.from('restaurants').delete().eq('id', rid)
    }
  }
  for (const uid of [ownerAId, ownerBId]) {
    if (uid) {
      await dbAdmin.from('users').delete().eq('id', uid)
      await authAdmin.auth.admin.deleteUser(uid)
    }
  }
}

async function api(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
) {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json }
}

async function verifyExistingAssignments() {
  const tables = ['restaurant_users', 'staff_invites', 'staff_members'] as const
  const violations: Array<{ table: string; restaurant_id: string; role: string }> = []

  const { data: roles } = await dbAdmin.from('restaurant_roles').select('restaurant_id, role_slug')
  const roleSet = new Set((roles ?? []).map((r) => `${r.restaurant_id}:${r.role_slug}`))

  for (const table of tables) {
    const { data: rows, error } = await dbAdmin.from(table).select('restaurant_id, role')
    if (error) throw error
    for (const row of rows ?? []) {
      const restaurantId = row.restaurant_id as string | null
      const role = row.role as string | null
      if (!restaurantId || !role) continue
      if (!roleSet.has(`${restaurantId}:${role}`)) {
        violations.push({ table, restaurant_id: restaurantId, role })
      }
    }
  }
  return violations
}

async function main() {
  const report: Record<string, unknown> = { app: APP, tag, permissionGate: PERMISSIONS.STAFF_MANAGE }

  const fkViolations = await verifyExistingAssignments()
  report.postMigrationFkIntegrity = { violationCount: fkViolations.length, violations: fkViolations }

  await setup()
  const ownerTok = await signIn(ownerAEmail)
  const ownerBTok = await signIn(ownerBEmail)

  // authorize() regression on disposable owner
  report.authorizeRegression = {
    ownerStaffManage: await authorize(ownerAId!, restAId!, PERMISSIONS.STAFF_MANAGE),
    ownerSettingsWrite: await authorize(ownerAId!, restAId!, PERMISSIONS.SETTINGS_WRITE),
  }

  const listRes = await api(ownerTok, 'GET', '/api/admin/restaurant-roles')
  report.listRoles = { status: listRes.status, count: (listRes.body.roles ?? []).length }

  const createRes = await api(ownerTok, 'POST', '/api/admin/restaurant-roles', {
    display_name: 'Head Chef',
    role_slug: 'head_chef',
    permissions: [PERMISSIONS.ORDERS_READ, PERMISSIONS.STOCK_VIEW],
    restaurant_id: restBId,
  })
  customRoleSlug = createRes.body?.role?.role_slug ?? 'head_chef'
  report.createCustomRole = {
    status: createRes.status,
    role_slug: customRoleSlug,
    permissions: createRes.body?.role?.permissions,
    is_system: createRes.body?.role?.is_system,
  }

  const patchOwner = await api(ownerTok, 'PATCH', '/api/admin/restaurant-roles/owner', {
    display_name: 'Hacked Owner',
  })
  const deleteOwner = await api(ownerTok, 'DELETE', '/api/admin/restaurant-roles/owner')
  report.systemRoleProtection = {
    patchStatus: patchOwner.status,
    patchError: patchOwner.body?.error,
    deleteStatus: deleteOwner.status,
    deleteError: deleteOwner.body?.error,
  }

  const { data: disposable, error: dispErr } = await dbAdmin
    .from('staff_members')
    .insert({
      restaurant_id: restAId,
      email: `${tag}.disposable@flashtap-test.invalid`,
      role: customRoleSlug,
      active: true,
    })
    .select('id')
    .single()
  if (dispErr) throw dispErr
  disposableStaffId = disposable.id

  const deleteBlocked = await api(ownerTok, 'DELETE', `/api/admin/restaurant-roles/${customRoleSlug}`)
  report.deleteWithAssignment = {
    status: deleteBlocked.status,
    error: deleteBlocked.body?.error,
  }

  await dbAdmin.from('staff_members').delete().eq('id', disposableStaffId)
  disposableStaffId = null

  const deleteOk = await api(ownerTok, 'DELETE', `/api/admin/restaurant-roles/${customRoleSlug}`)
  report.deleteAfterReassign = { status: deleteOk.status }
  if (deleteOk.status === 200) customRoleSlug = null

  const crossCreate = await api(ownerBTok, 'POST', '/api/admin/restaurant-roles', {
    display_name: 'Cross Tenant Role',
    role_slug: 'cross_tenant',
    permissions: [PERMISSIONS.ORDERS_READ],
    restaurant_id: restAId,
  })
  const { data: rolesOnA } = await dbAdmin
    .from('restaurant_roles')
    .select('role_slug')
    .eq('restaurant_id', restAId!)
    .eq('role_slug', 'cross_tenant')
  const { data: rolesOnB } = await dbAdmin
    .from('restaurant_roles')
    .select('role_slug')
    .eq('restaurant_id', restBId!)
    .eq('role_slug', 'cross_tenant')

  report.crossTenant = {
    createStatus: crossCreate.status,
    createdOnRestaurantA: (rolesOnA ?? []).length > 0,
    createdOnRestaurantB: (rolesOnB ?? []).length > 0,
    createdRestaurantId: crossCreate.body?.role?.restaurant_id ?? null,
  }

  if ((rolesOnB ?? []).length > 0) {
    await dbAdmin
      .from('restaurant_roles')
      .delete()
      .eq('restaurant_id', restBId!)
      .eq('role_slug', 'cross_tenant')
  }

  console.log(JSON.stringify(report, null, 2))

  const pass =
    fkViolations.length === 0 &&
    report.authorizeRegression.ownerStaffManage === true &&
    report.authorizeRegression.ownerSettingsWrite === true &&
    listRes.status === 200 &&
    (listRes.body.roles ?? []).length >= 6 &&
    createRes.status === 201 &&
    createRes.body?.role?.is_system === false &&
    patchOwner.status === 403 &&
    deleteOwner.status === 403 &&
    deleteBlocked.status === 409 &&
    String(deleteBlocked.body?.error || '').includes('1 staff member') &&
    deleteOk.status === 200 &&
    crossCreate.status === 201 &&
    report.crossTenant.createdOnRestaurantA === false &&
    report.crossTenant.createdOnRestaurantB === true

  if (!pass) {
    console.error('RESTAURANT_ROLES_PHASE4A_FAIL')
    process.exitCode = 1
  } else {
    console.log('RESTAURANT_ROLES_PHASE4A_OK')
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
      console.error('Cleanup error:', e)
    }
  })
