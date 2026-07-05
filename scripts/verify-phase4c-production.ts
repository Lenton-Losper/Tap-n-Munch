/**
 * Phase 4C production verification: Role Editor + custom role end-to-end (Riviera).
 *   npx tsx scripts/verify-phase4c-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { PERMISSIONS } from '../lib/permissions'
import { authorize } from '../lib/permissions/authorize'
import { isStaffAssignableRole } from '../lib/restaurant-roles/assignable'

config({ path: '.env.production.local', override: true })

const APP = process.env.PRODUCTION_APP_URL || 'https://www.flashtap.app'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const tag = `phase4c-prod-${Date.now()}`
const pw = `Verify${randomUUID().slice(0, 8)}!1`
const CUSTOM_ROLE_NAME = `Head Chef ${tag.slice(-6)}`

const SYSTEM_SLUGS = ['owner', 'manager', 'cashier', 'waiter', 'kitchen', 'bar'] as const

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

if (!url?.includes(PROD_REF)) throw new Error(`Refusing: not production Supabase (${url})`)

const dbAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const authAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anon = createClient(url, anonKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let disposableUserId: string | null = null
let customRoleSlug: string | null = null
const disposableEmail = `${tag}.staff@flashtap-test.invalid`

async function resolveRivieraOwnerEmail(): Promise<string> {
  const { data: ownerRow, error } = await dbAdmin
    .from('restaurant_users')
    .select('user_id')
    .eq('restaurant_id', RIVIERA_ID)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!ownerRow?.user_id) throw new Error('No Riviera owner')

  const { data: userRow, error: userError } = await dbAdmin
    .from('users')
    .select('email')
    .eq('id', ownerRow.user_id)
    .maybeSingle()
  if (userError) throw userError
  const email = String(userRow?.email || '').trim()
  if (!email) throw new Error('Riviera owner has no email')
  return email
}

async function ownerToken(): Promise<string> {
  const ownerEmail = await resolveRivieraOwnerEmail()
  const { data: link, error: linkErr } = await authAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: ownerEmail,
  })
  if (linkErr || !link?.properties?.hashed_token) {
    throw new Error(`Owner magic link failed: ${linkErr?.message}`)
  }
  const { data: sess, error: otpErr } = await authAdmin.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'magiclink',
  })
  if (otpErr || !sess.session?.access_token) {
    throw new Error(`Owner OTP failed: ${otpErr?.message}`)
  }
  return sess.session.access_token
}

async function signInDisposable() {
  const { data, error } = await anon.auth.signInWithPassword({
    email: disposableEmail,
    password: pw,
  })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session.access_token
}

async function setupDisposableStaff() {
  const { data: u, error } = await authAdmin.auth.admin.createUser({
    email: disposableEmail,
    password: pw,
    email_confirm: true,
  })
  if (error || !u.user) throw error
  disposableUserId = u.user.id

  await dbAdmin.from('users').insert({
    id: disposableUserId,
    email: disposableEmail,
    role: 'waiter',
    restaurant_id: RIVIERA_ID,
    full_name: 'Phase4C Disposable',
  })

  await dbAdmin.from('restaurant_users').insert({
    restaurant_id: RIVIERA_ID,
    user_id: disposableUserId,
    role: 'waiter',
    invite_accepted: true,
  })
}

async function cleanupLeftovers() {
  const { data: users } = await dbAdmin
    .from('users')
    .select('id, email')
    .like('email', 'phase4c-prod-%')
  for (const row of users ?? []) {
    await dbAdmin.from('restaurant_users').delete().eq('user_id', row.id)
    await dbAdmin.from('users').delete().eq('id', row.id)
    await authAdmin.auth.admin.deleteUser(row.id).catch(() => undefined)
  }
  await dbAdmin.from('staff_invites').delete().like('email', 'phase4c-prod-%')
  const { data: roles } = await dbAdmin
    .from('restaurant_roles')
    .select('role_slug')
    .eq('restaurant_id', RIVIERA_ID)
    .like('role_slug', 'head_chef%')
  for (const row of roles ?? []) {
    await dbAdmin
      .from('restaurant_roles')
      .delete()
      .eq('restaurant_id', RIVIERA_ID)
      .eq('role_slug', row.role_slug)
  }
}

async function cleanup() {
  if (customRoleSlug) {
    await dbAdmin
      .from('restaurant_roles')
      .delete()
      .eq('restaurant_id', RIVIERA_ID)
      .eq('role_slug', customRoleSlug)
  }
  await dbAdmin.from('staff_invites').delete().eq('restaurant_id', RIVIERA_ID).like('email', `${tag}%`)

  if (disposableUserId) {
    await dbAdmin
      .from('restaurant_users')
      .delete()
      .eq('restaurant_id', RIVIERA_ID)
      .eq('user_id', disposableUserId)
    await dbAdmin.from('users').delete().eq('id', disposableUserId)
    await authAdmin.auth.admin.deleteUser(disposableUserId).catch(() => undefined)
  }
}

async function main() {
  const expectedPrefix = process.env.EXPECTED_COMMIT_PREFIX || 'fcc3aa0'
  const versionRes = await fetch(`${APP}/api/version`)
  const versionBody = (await versionRes.json()) as { commit?: string }
  const commit = versionBody.commit ?? ''
  console.log(`Production commit: ${commit}`)
  if (!commit.startsWith(expectedPrefix.slice(0, 7))) {
    throw new Error(`Deploy not ready: expected prefix ${expectedPrefix.slice(0, 7)}, got ${commit}`)
  }

  const report: Record<string, unknown> = { app: APP, tag, commit, restaurant: 'Riviera' }

  await cleanupLeftovers()
  await setupDisposableStaff()

  const ownerTok = await ownerToken()

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
    roles: roles.map((r) => ({
      slug: r.role_slug,
      assigned_count: r.assigned_count,
      is_system: r.is_system,
    })),
  }

  const kitchen = roles.find((r) => r.role_slug === 'kitchen')
  if (!kitchen) throw new Error('kitchen role missing on Riviera')

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

  const assignableSlugs = (rolesAfter.roles ?? [])
    .filter(isStaffAssignableRole)
    .map((r: { role_slug: string }) => r.role_slug)

  report.customInAssignableDropdown = assignableSlugs.includes(customRoleSlug)

  const patchAssign = await fetch(`${APP}/api/admin/staff/${disposableUserId}`, {
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
    .eq('user_id', disposableUserId!)
    .eq('restaurant_id', RIVIERA_ID)
    .single()
  report.roleAfterAssign = ruAfter?.role

  const staffTok = await signInDisposable()
  const roleApi = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${staffTok}` },
  })
  const roleApiBody = await roleApi.json()

  const stockAllowed = await authorize(disposableUserId!, RIVIERA_ID, PERMISSIONS.STOCK_VIEW)
  const analyticsAllowed = await authorize(disposableUserId!, RIVIERA_ID, PERMISSIONS.ANALYTICS_VIEW)
  const settingsAllowed = await authorize(disposableUserId!, RIVIERA_ID, PERMISSIONS.SETTINGS_READ)
  const staffManageAllowed = await authorize(disposableUserId!, RIVIERA_ID, PERMISSIONS.STAFF_MANAGE)

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

  const reassign = await fetch(`${APP}/api/admin/staff/${disposableUserId}`, {
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
  if (deleteAfterReassign.status === 200) customRoleSlug = null

  console.log(JSON.stringify(report, null, 2))

  const systemOk =
    roles.length >= 6 &&
    SYSTEM_SLUGS.every((slug) => roles.some((r) => r.role_slug === slug)) &&
    roles.every((r) => typeof r.assigned_count === 'number') &&
    roles.some((r) => r.role_slug === 'owner' && r.is_system)

  const pass =
    rolesRes.status === 200 &&
    systemOk &&
    createRes.status === 201 &&
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
    console.error('PHASE4C_PRODUCTION_FAIL')
    process.exitCode = 1
  } else {
    console.log('PHASE4C_PRODUCTION_OK')
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
      await cleanupLeftovers()
      console.log('Cleanup complete.')
    } catch (e) {
      console.error('Cleanup error:', e)
    }
  })
