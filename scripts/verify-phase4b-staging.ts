/**
 * Phase 4B staging verification: dynamic role assignment from restaurant_roles.
 *   npx tsx scripts/verify-phase4b-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import rolePermissionsConfig from '../lib/permissions/role-permissions.config.json'
import { isStaffAssignableRole } from '../lib/restaurant-roles/assignable'

config({ path: '.env.test', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const tag = `phase4b-${Date.now()}`
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

let restId: string | null = null
let ownerId: string | null = null
let waiterUserId: string | null = null
let inviteManagerId: string | null = null
let inviteWaiterId: string | null = null

const ownerEmail = `${tag}.owner@flashtap-test.invalid`
const waiterEmail = `${tag}.waiter@flashtap-test.invalid`

const LEGACY_ASSIGNABLE = ['cashier', 'kitchen', 'manager', 'waiter']
const LEGACY_INVITE_ELIGIBLE = ['manager', 'waiter']

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
    is_invite_eligible: LEGACY_INVITE_ELIGIBLE.includes(slug),
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
    [waiterEmail, 'waiter'],
  ] as const) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error
    if (label === 'owner') ownerId = u.user.id
    if (label === 'waiter') waiterUserId = u.user.id
  }

  await dbAdmin.from('users').insert([
    { id: ownerId, email: ownerEmail, role: 'owner', restaurant_id: restId, full_name: 'Owner' },
    { id: waiterUserId, email: waiterEmail, role: 'waiter', restaurant_id: restId, full_name: 'Waiter' },
  ])

  await dbAdmin.from('restaurant_users').insert([
    { restaurant_id: restId, user_id: ownerId, role: 'owner', invite_accepted: true },
    { restaurant_id: restId, user_id: waiterUserId, role: 'waiter', invite_accepted: true },
  ])
}

async function cleanup() {
  if (inviteManagerId) await dbAdmin.from('staff_invites').delete().eq('id', inviteManagerId)
  if (inviteWaiterId) await dbAdmin.from('staff_invites').delete().eq('id', inviteWaiterId)
  if (restId) {
    await dbAdmin.from('staff_invites').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurants').delete().eq('id', restId)
  }
  for (const uid of [ownerId, waiterUserId]) {
    if (uid) {
      await dbAdmin.from('users').delete().eq('id', uid)
      await authAdmin.auth.admin.deleteUser(uid)
    }
  }
}

async function verifySeedFidelityAllRestaurants() {
  const { data, error } = await dbAdmin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, is_invite_eligible')
  if (error) throw error

  const violations: string[] = []
  for (const row of data ?? []) {
    const slug = String(row.role_slug)
    const eligible = Boolean(row.is_invite_eligible)
    const shouldBe = LEGACY_INVITE_ELIGIBLE.includes(slug)
    if (slug === 'owner' || slug === 'cashier' || slug === 'kitchen' || slug === 'bar') {
      if (eligible) violations.push(`${row.restaurant_id}:${slug} should not be invite-eligible`)
    } else if (slug === 'manager' || slug === 'waiter') {
      if (!eligible) violations.push(`${row.restaurant_id}:${slug} should be invite-eligible`)
    }
  }
  return { rowCount: data?.length ?? 0, violations }
}

async function main() {
  const report: Record<string, unknown> = { app: APP, tag }

  report.seedFidelity = await verifySeedFidelityAllRestaurants()
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
    is_invite_eligible: boolean
  }>

  const assignableSlugs = roles
    .filter(isStaffAssignableRole)
    .map((r) => r.role_slug)
    .sort()
  const inviteSlugs = roles
    .filter((r) => r.is_invite_eligible)
    .map((r) => r.role_slug)
    .sort()

  report.rolesApi = {
    status: rolesRes.status,
    assignableSlugs,
    inviteSlugs,
    includesBarInAssignable: assignableSlugs.includes('bar'),
  }

  const patchKitchen = await fetch(`${APP}/api/admin/staff/${waiterUserId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'kitchen' }),
  })
  report.roleChange = { status: patchKitchen.status }

  const { data: ruAfter } = await dbAdmin
    .from('restaurant_users')
    .select('role')
    .eq('user_id', waiterUserId!)
    .eq('restaurant_id', restId!)
    .single()
  report.roleAfterChange = ruAfter?.role

  const inviteManager = await fetch(`${APP}/api/admin/invites`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: `${tag}.mgr@flashtap-test.invalid`,
      role: 'manager',
    }),
  })
  const inviteManagerBody = await inviteManager.json()
  inviteManagerId = inviteManagerBody?.invite?.id ?? null

  const inviteWaiter = await fetch(`${APP}/api/admin/invites`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: `${tag}.wtr@flashtap-test.invalid`,
      role: 'waiter',
    }),
  })
  const inviteWaiterBody = await inviteWaiter.json()
  inviteWaiterId = inviteWaiterBody?.invite?.id ?? null

  const inviteKitchen = await fetch(`${APP}/api/admin/invites`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: `${tag}.kit@flashtap-test.invalid`,
      role: 'kitchen',
    }),
  })
  const inviteKitchenBody = await inviteKitchen.json()

  report.invites = {
    manager: inviteManager.status,
    waiter: inviteWaiter.status,
    kitchen: inviteKitchen.status,
    kitchenError: inviteKitchenBody?.error,
  }

  const patchBar = await fetch(`${APP}/api/admin/staff/${waiterUserId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'bar' }),
  })
  report.barPatchRejected = patchBar.status

  console.log(JSON.stringify(report, null, 2))

  const seedOk = (report.seedFidelity as { violations: string[] }).violations.length === 0
  const pass =
    seedOk &&
    rolesRes.status === 200 &&
    JSON.stringify(assignableSlugs) === JSON.stringify([...LEGACY_ASSIGNABLE].sort()) &&
    JSON.stringify(inviteSlugs) === JSON.stringify([...LEGACY_INVITE_ELIGIBLE].sort()) &&
    (report.rolesApi as { includesBarInAssignable: boolean }).includesBarInAssignable === false &&
    patchKitchen.status === 200 &&
    report.roleAfterChange === 'kitchen' &&
    inviteManager.status === 200 &&
    inviteWaiter.status === 200 &&
    inviteKitchen.status === 400 &&
    patchBar.status === 400

  if (!pass) {
    console.error('PHASE4B_STAGING_FAIL')
    process.exitCode = 1
  } else {
    console.log('PHASE4B_STAGING_OK')
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
