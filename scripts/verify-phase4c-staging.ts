/**
 * Phase 4C staging verification: Role Editor UI + end-to-end custom role flow.
 *   npx tsx scripts/verify-phase4c-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import rolePermissionsConfig from '../lib/permissions/role-permissions.config.json'
import { PERMISSIONS } from '../lib/permissions'
import { authorize } from '../lib/permissions/authorize'
import { isStaffAssignableRole } from '../lib/restaurant-roles/assignable'

config({ path: '.env.test', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const tag = `phase4c-${Date.now()}`
const pw = `Set${randomUUID().slice(0, 8)}!1`
const CUSTOM_ROLE_NAME = `Head Chef ${tag.slice(-6)}`

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

const SYSTEM_SLUGS = ['owner', 'manager', 'cashier', 'waiter', 'kitchen', 'bar'] as const

let restId: string | null = null
let ownerId: string | null = null
let staffUserId: string | null = null
let customRoleSlug: string | null = null

const ownerEmail = `${tag}.owner@flashtap-test.invalid`
const staffEmail = `${tag}.staff@flashtap-test.invalid`

const DISPLAY_NAMES: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  waiter: 'Waiter',
  kitchen: 'Kitchen',
  bar: 'Bar',
}

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
    is_invite_eligible: slug === 'manager' || slug === 'waiter',
  }))
  const { error } = await dbAdmin.from('restaurant_roles').insert(rows)
  if (error) throw error
}

async function setup() {
  const { data: rest, error: restErr } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} Restaurant`, slug: `${tag}` })
    .select('id')
    .single()
  if (restErr || !rest?.id) throw restErr ?? new Error('restaurant insert failed')
  restId = rest.id
  await seedRestaurantRoles(rest.id)

  for (const [email, label] of [
    [ownerEmail, 'owner'],
    [staffEmail, 'staff'],
  ] as const) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error
    if (label === 'owner') ownerId = u.user.id
    if (label === 'staff') staffUserId = u.user.id
  }

  await dbAdmin.from('users').insert([
    { id: ownerId, email: ownerEmail, role: 'owner', restaurant_id: restId, full_name: 'Owner' },
    { id: staffUserId, email: staffEmail, role: 'waiter', restaurant_id: restId, full_name: 'Staff' },
  ])

  await dbAdmin.from('restaurant_users').insert([
    { restaurant_id: restId, user_id: ownerId, role: 'owner', invite_accepted: true },
    { restaurant_id: restId, user_id: staffUserId, role: 'waiter', invite_accepted: true },
  ])
}

async function cleanup() {
  if (customRoleSlug && restId) {
    await dbAdmin
      .from('restaurant_roles')
      .delete()
      .eq('restaurant_id', restId)
      .eq('role_slug', customRoleSlug)
  }
  if (restId) {
    await dbAdmin.from('staff_invites').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurants').delete().eq('id', restId)
  }
  for (const uid of [ownerId, staffUserId]) {
    if (uid) {
      await dbAdmin.from('users').delete().eq('id', uid)
      await authAdmin.auth.admin.deleteUser(uid)
    }
  }
}

async function main() {
  const report: Record<string, unknown> = { app: APP, tag }
  await setup()

  const ownerTok = await signIn(ownerEmail)

  const rolesRes = await fetch(`${APP}/api/admin/restaurant-roles`, {
    headers: { Authorization: `Bearer ${ownerTok}` },
  })
  const rolesBody = await rolesRes.json()
  const roles = (rolesBody.roles ?? []) as Array<{
    role_slug: string
    display_name: string
    is_system: boolean
    assigned_count: number
    permissions: string[]
  }>

  report.roleList = {
    status: rolesRes.status,
    count: roles.length,
    systemRoles: roles.filter((r) => r.is_system).map((r) => ({
      slug: r.role_slug,
      assigned_count: r.assigned_count,
    })),
  }

  const kitchen = roles.find((r) => r.role_slug === 'kitchen')
  if (!kitchen) throw new Error('kitchen role missing')

  const headChefPerms = (kitchen.permissions ?? []).filter((p) => p !== PERMISSIONS.ANALYTICS_VIEW)

  const createRes = await fetch(`${APP}/api/admin/restaurant-roles`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      display_name: CUSTOM_ROLE_NAME,
      permissions: headChefPerms,
      is_invite_eligible: false,
    }),
  })
  const createBody = await createRes.json()
  customRoleSlug = createBody?.role?.role_slug ?? null

  report.createCustomRole = {
    status: createRes.status,
    role_slug: customRoleSlug,
    display_name: createBody?.role?.display_name,
    permissions: createBody?.role?.permissions,
  }

  const rolesAfter = await fetch(`${APP}/api/admin/restaurant-roles`, {
    headers: { Authorization: `Bearer ${ownerTok}` },
  }).then((r) => r.json())
  const customInList = (rolesAfter.roles ?? []).find(
    (r: { role_slug: string }) => r.role_slug === customRoleSlug,
  )
  report.customRoleInList = Boolean(customInList)

  const assignableSlugs = (rolesAfter.roles ?? [])
    .filter(isStaffAssignableRole)
    .map((r: { role_slug: string }) => r.role_slug)
  report.customInAssignableDropdown = assignableSlugs.includes(customRoleSlug)

  const patchAssign = await fetch(`${APP}/api/admin/staff/${staffUserId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: customRoleSlug }),
  })
  report.assignCustomRole = { status: patchAssign.status }

  const { data: ruAfter } = await dbAdmin
    .from('restaurant_users')
    .select('role')
    .eq('user_id', staffUserId!)
    .eq('restaurant_id', restId!)
    .single()
  report.roleAfterAssign = ruAfter?.role

  const staffTok = await signIn(staffEmail)
  const roleApi = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${staffTok}` },
  })
  const roleApiBody = await roleApi.json()

  const stockAllowed = await authorize(staffUserId!, restId!, PERMISSIONS.STOCK_VIEW)
  const analyticsAllowed = await authorize(staffUserId!, restId!, PERMISSIONS.ANALYTICS_VIEW)
  const settingsAllowed = await authorize(staffUserId!, restId!, PERMISSIONS.SETTINGS_READ)
  const staffManageAllowed = await authorize(staffUserId!, restId!, PERMISSIONS.STAFF_MANAGE)

  report.permissionGates = {
    roleApiStatus: roleApi.status,
    permissions: roleApiBody.permissions,
    stockView: stockAllowed,
    analyticsView: analyticsAllowed,
    settingsRead: settingsAllowed,
    staffManage: staffManageAllowed,
  }

  const patchOwner = await fetch(`${APP}/api/admin/restaurant-roles/owner`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ display_name: 'Hacked Owner' }),
  })
  const deleteOwner = await fetch(`${APP}/api/admin/restaurant-roles/owner`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ownerTok}` },
  })

  report.systemRoleProtection = {
    patchOwner: patchOwner.status,
    deleteOwner: deleteOwner.status,
  }

  const deleteWhileAssigned = await fetch(
    `${APP}/api/admin/restaurant-roles/${encodeURIComponent(customRoleSlug!)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerTok}` },
    },
  )
  const deleteWhileAssignedBody = await deleteWhileAssigned.json()

  report.deleteWhileAssigned = {
    status: deleteWhileAssigned.status,
    error: deleteWhileAssignedBody?.error,
  }

  const reassign = await fetch(`${APP}/api/admin/staff/${staffUserId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'waiter' }),
  })

  const deleteAfterReassign = await fetch(
    `${APP}/api/admin/restaurant-roles/${encodeURIComponent(customRoleSlug!)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerTok}` },
    },
  )

  report.deleteAfterReassign = {
    reassignStatus: reassign.status,
    deleteStatus: deleteAfterReassign.status,
  }

  const createdSlug = customRoleSlug

  if (deleteAfterReassign.status === 200) {
    customRoleSlug = null
  }

  console.log(JSON.stringify(report, null, 2))

  const systemOk =
    roles.length >= 6 &&
    SYSTEM_SLUGS.every((slug) => roles.some((r) => r.role_slug === slug)) &&
    roles.some((r) => r.role_slug === 'owner' && r.is_system)

  const pass =
    rolesRes.status === 200 &&
    systemOk &&
    createRes.status === 201 &&
    customInList &&
    assignableSlugs.includes(createdSlug ?? '') &&
    patchAssign.status === 200 &&
    ruAfter?.role === createBody?.role?.role_slug &&
    stockAllowed === true &&
    analyticsAllowed === false &&
    patchOwner.status === 403 &&
    deleteOwner.status === 403 &&
    deleteWhileAssigned.status === 409 &&
    reassign.status === 200 &&
    deleteAfterReassign.status === 200

  if (!pass) {
    console.error('PHASE4C_STAGING_FAIL')
    process.exitCode = 1
  } else {
    console.log('PHASE4C_STAGING_OK')
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
