/**
 * Staging verification for Staff Phase 3 permission migration.
 *   npx tsx scripts/verify-staff-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { PERMISSIONS } from '../lib/permissions'

config({ path: '.env.test', override: true })

const APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const tag = `staff-verify-${Date.now()}`
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
let ownerBId: string | null = null
let managerId: string | null = null
let waiterId: string | null = null
let kitchenId: string | null = null
let waiterStaffId: string | null = null
let inviteBId: string | null = null

const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`
const managerEmail = `${tag}.manager@flashtap-test.invalid`
const waiterEmail = `${tag}.waiter@flashtap-test.invalid`
const kitchenEmail = `${tag}.kitchen@flashtap-test.invalid`

async function signIn(email: string) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session.access_token
}

async function fetchStaffPage(token: string) {
  const res = await fetch(`${APP}/staff`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  })
  const body = await res.text()
  const rscRedirect =
    body.includes('NEXT_REDIRECT') &&
    (body.includes('/dashboard') || body.includes('/signin'))
  return { status: res.status, rscRedirect }
}

async function fetchRoleApi(token: string) {
  const res = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: res.status, body: await res.json() }
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

  for (const [email, label] of [
    [ownerAEmail, 'ownerA'],
    [ownerBEmail, 'ownerB'],
    [managerEmail, 'manager'],
    [waiterEmail, 'waiter'],
    [kitchenEmail, 'kitchen'],
  ] as const) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error
    if (label === 'ownerA') ownerAId = u.user.id
    if (label === 'ownerB') ownerBId = u.user.id
    if (label === 'manager') managerId = u.user.id
    if (label === 'waiter') waiterId = u.user.id
    if (label === 'kitchen') kitchenId = u.user.id
  }

  await dbAdmin.from('users').insert([
    { id: ownerAId, email: ownerAEmail, role: 'owner', restaurant_id: restAId, full_name: 'OA' },
    { id: ownerBId, email: ownerBEmail, role: 'owner', restaurant_id: restBId, full_name: 'OB' },
    { id: managerId, email: managerEmail, role: 'manager', restaurant_id: restAId, full_name: 'M' },
    { id: waiterId, email: waiterEmail, role: 'waiter', restaurant_id: restAId, full_name: 'W' },
    { id: kitchenId, email: kitchenEmail, role: 'kitchen', restaurant_id: restAId, full_name: 'K' },
  ])

  await dbAdmin.from('restaurant_users').insert([
    { restaurant_id: restAId, user_id: ownerAId, role: 'owner', invite_accepted: true },
    { restaurant_id: restBId, user_id: ownerBId, role: 'owner', invite_accepted: true },
    { restaurant_id: restAId, user_id: managerId, role: 'manager', invite_accepted: true },
    { restaurant_id: restAId, user_id: waiterId, role: 'waiter', invite_accepted: true },
    { restaurant_id: restAId, user_id: kitchenId, role: 'kitchen', invite_accepted: true },
  ])

  const { data: staff, error: staffErr } = await dbAdmin
    .from('staff_members')
    .insert({ restaurant_id: restAId, email: waiterEmail, role: 'waiter', active: true })
    .select('id')
    .single()
  if (staffErr) throw staffErr
  waiterStaffId = staff.id

  const { data: inviteB, error: inviteErr } = await dbAdmin
    .from('staff_invites')
    .insert({
      restaurant_id: restBId,
      email: `${tag}.b-invite@flashtap-test.invalid`,
      role: 'waiter',
      token: randomUUID(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      invited_by: ownerBId,
      accepted: false,
    })
    .select('id')
    .single()
  if (inviteErr) throw inviteErr
  inviteBId = inviteB.id
}

async function cleanup() {
  if (waiterStaffId) {
    await dbAdmin.from('staff_permissions').delete().eq('staff_id', waiterStaffId)
    await dbAdmin.from('staff_members').delete().eq('id', waiterStaffId)
  }
  if (inviteBId) await dbAdmin.from('staff_invites').delete().eq('id', inviteBId)
  for (const rid of [restAId, restBId]) {
    if (rid) {
      await dbAdmin.from('staff_invites').delete().eq('restaurant_id', rid)
      await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', rid)
      await dbAdmin.from('restaurants').delete().eq('id', rid)
    }
  }
  for (const uid of [ownerAId, ownerBId, managerId, waiterId, kitchenId]) {
    if (uid) {
      await dbAdmin.from('users').delete().eq('id', uid)
      await authAdmin.auth.admin.deleteUser(uid)
    }
  }
}

async function main() {
  const report: Record<string, unknown> = { app: APP, tag }
  await setup()

  const ownerTok = await signIn(ownerAEmail)
  const managerTok = await signIn(managerEmail)
  const waiterTok = await signIn(waiterEmail)
  const kitchenTok = await signIn(kitchenEmail)

  const ownerStaffGet = await fetch(`${APP}/api/admin/staff`, {
    headers: { Authorization: `Bearer ${ownerTok}` },
  })
  const ownerInvitesGet = await fetch(`${APP}/api/admin/invites`, {
    headers: { Authorization: `Bearer ${ownerTok}` },
  })
  const ownerInvitePost = await fetch(`${APP}/api/admin/invites`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: `${tag}.new-invite@flashtap-test.invalid`,
      role: 'waiter',
    }),
  })
  const ownerInvitePostBody = await ownerInvitePost.json().catch(() => ({}))
  const createdInviteId = (ownerInvitePostBody as { invite?: { id?: string } }).invite?.id

  let ownerCancelStatus: number | null = null
  if (createdInviteId) {
    ownerCancelStatus = (
      await fetch(`${APP}/api/admin/invites/${createdInviteId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerTok}` },
      })
    ).status
  }

  const managerStaffGet = await fetch(`${APP}/api/admin/staff`, {
    headers: { Authorization: `Bearer ${managerTok}` },
  })
  const managerInvitesGet = await fetch(`${APP}/api/admin/invites`, {
    headers: { Authorization: `Bearer ${managerTok}` },
  })
  const managerStaffPage = await fetchStaffPage(managerTok)
  const managerRoleApi = await fetchRoleApi(managerTok)

  const waiterStaffGet = await fetch(`${APP}/api/admin/staff`, {
    headers: { Authorization: `Bearer ${waiterTok}` },
  })
  const waiterInvitesGet = await fetch(`${APP}/api/admin/invites`, {
    headers: { Authorization: `Bearer ${waiterTok}` },
  })
  const waiterStaffPage = await fetchStaffPage(waiterTok)

  const kitchenStaffGet = await fetch(`${APP}/api/admin/staff`, {
    headers: { Authorization: `Bearer ${kitchenTok}` },
  })
  const kitchenStaffPage = await fetchStaffPage(kitchenTok)

  await dbAdmin.from('staff_permissions').insert({
    staff_id: waiterStaffId,
    restaurant_id: restAId,
    permission: PERMISSIONS.STAFF_MANAGE,
    effect: 'allow',
  })
  const overrideTok = await signIn(waiterEmail)
  const overrideRoleApi = await fetchRoleApi(overrideTok)
  const overrideStaffGet = await fetch(`${APP}/api/admin/staff`, {
    headers: { Authorization: `Bearer ${overrideTok}` },
  })
  const overrideInvitesGet = await fetch(`${APP}/api/admin/invites`, {
    headers: { Authorization: `Bearer ${overrideTok}` },
  })

  const crossList = await fetch(`${APP}/api/admin/invites`, {
    headers: { Authorization: `Bearer ${ownerTok}` },
  })
  const crossListBody = await crossList.json()
  const crossDelete = await fetch(`${APP}/api/admin/invites/${inviteBId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ownerTok}` },
  })

  report.owner = {
    staffGet: ownerStaffGet.status,
    invitesGet: ownerInvitesGet.status,
    invitePost: ownerInvitePost.status,
    inviteCancel: ownerCancelStatus,
  }
  report.manager = {
    staffGet: managerStaffGet.status,
    invitesGet: managerInvitesGet.status,
    staffPageRscRedirect: managerStaffPage.rscRedirect,
    hasStaffManage: (managerRoleApi.body.permissions ?? []).includes(PERMISSIONS.STAFF_MANAGE),
  }
  report.waiter = {
    staffGet: waiterStaffGet.status,
    invitesGet: waiterInvitesGet.status,
    staffPageRscRedirect: waiterStaffPage.rscRedirect,
  }
  report.kitchen = {
    staffGet: kitchenStaffGet.status,
    staffPageRscRedirect: kitchenStaffPage.rscRedirect,
  }
  report.staffManageOverride = {
    hasStaffManage: (overrideRoleApi.body.permissions ?? []).includes(PERMISSIONS.STAFF_MANAGE),
    staffGet: overrideStaffGet.status,
    invitesGet: overrideInvitesGet.status,
  }
  report.crossTenantInvites = {
    ownerListCount: Array.isArray(crossListBody.invites) ? crossListBody.invites.length : null,
    leakedBInvite: Array.isArray(crossListBody.invites)
      ? crossListBody.invites.some((i: { id?: string }) => i.id === inviteBId)
      : null,
    crossDeleteStatus: crossDelete.status,
  }

  console.log(JSON.stringify(report, null, 2))

  const o = report.owner as Record<string, number | null>
  const m = report.manager as Record<string, unknown>
  const w = report.waiter as Record<string, unknown>
  const k = report.kitchen as Record<string, unknown>
  const ov = report.staffManageOverride as Record<string, unknown>
  const x = report.crossTenantInvites as Record<string, unknown>

  const pass =
    o.staffGet === 200 &&
    o.invitesGet === 200 &&
    o.invitePost === 200 &&
    o.inviteCancel === 200 &&
    m.staffGet === 200 &&
    m.invitesGet === 200 &&
    m.hasStaffManage === true &&
    w.staffGet === 403 &&
    w.invitesGet === 403 &&
  w.staffPageRscRedirect === true &&
    k.staffGet === 403 &&
    k.staffPageRscRedirect === true &&
    ov.hasStaffManage === true &&
    ov.staffGet === 200 &&
    ov.invitesGet === 200 &&
    x.leakedBInvite === false &&
    x.crossDeleteStatus === 403

  if (!pass) {
    console.error('STAFF_STAGING_FAIL')
    process.exitCode = 1
  } else {
    console.log('STAFF_STAGING_OK')
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
