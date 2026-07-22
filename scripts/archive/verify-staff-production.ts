/**
 * Production verification for Staff Phase 3 permission migration.
 *   npx tsx scripts/verify-staff-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { PERMISSIONS } from '../lib/permissions'

config({ path: '.env.production.local', override: true })

const APP = process.env.PRODUCTION_APP_URL || 'https://www.flashtap.app'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const tag = `staff-prod-verify-${Date.now()}`
const pw = `Verify${randomUUID().slice(0, 8)}!1`

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

let restBId: string | null = null
let ownerBId: string | null = null
let managerId: string | null = null
let waiterId: string | null = null
let kitchenId: string | null = null
let waiterStaffId: string | null = null
let inviteBId: string | null = null
let createdInviteId: string | null = null

const managerEmail = `${tag}.manager@flashtap-test.invalid`
const waiterEmail = `${tag}.waiter@flashtap-test.invalid`
const kitchenEmail = `${tag}.kitchen@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`

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

async function cleanupLeftovers() {
  const { data: users } = await dbAdmin
    .from('users')
    .select('id, email')
    .like('email', 'staff-prod-verify-%')
  for (const row of users ?? []) {
    const { data: staffRows } = await dbAdmin
      .from('staff_members')
      .select('id')
      .ilike('email', row.email)
    for (const staff of staffRows ?? []) {
      await dbAdmin.from('staff_permissions').delete().eq('staff_id', staff.id)
      await dbAdmin.from('staff_members').delete().eq('id', staff.id)
    }
    await dbAdmin.from('restaurant_users').delete().eq('user_id', row.id)
    await dbAdmin.from('users').delete().eq('id', row.id)
    await authAdmin.auth.admin.deleteUser(row.id).catch(() => undefined)
  }
  const { data: leakRestaurants } = await dbAdmin
    .from('restaurants')
    .select('id, owner_id')
    .like('name', 'staff-prod-verify-%')
  for (const leak of leakRestaurants ?? []) {
    await dbAdmin.from('staff_invites').delete().eq('restaurant_id', leak.id)
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', leak.id)
    await dbAdmin.from('restaurants').delete().eq('id', leak.id)
    if (leak.owner_id) {
      await dbAdmin.from('users').delete().eq('id', leak.owner_id)
      await authAdmin.auth.admin.deleteUser(String(leak.owner_id)).catch(() => undefined)
    }
  }
}

async function setup() {
  for (const [email, label] of [
    [managerEmail, 'manager'],
    [waiterEmail, 'waiter'],
    [kitchenEmail, 'kitchen'],
    [ownerBEmail, 'ownerB'],
  ] as const) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error
    if (label === 'manager') managerId = u.user.id
    if (label === 'waiter') waiterId = u.user.id
    if (label === 'kitchen') kitchenId = u.user.id
    if (label === 'ownerB') ownerBId = u.user.id
  }

  await dbAdmin.from('users').insert([
    { id: managerId, email: managerEmail, role: 'manager', restaurant_id: RIVIERA_ID, full_name: 'M' },
    { id: waiterId, email: waiterEmail, role: 'waiter', restaurant_id: RIVIERA_ID, full_name: 'W' },
    { id: kitchenId, email: kitchenEmail, role: 'kitchen', restaurant_id: RIVIERA_ID, full_name: 'K' },
    { id: ownerBId, email: ownerBEmail, role: 'owner', full_name: 'OB' },
  ])

  await dbAdmin.from('restaurant_users').insert([
    { restaurant_id: RIVIERA_ID, user_id: managerId, role: 'manager', invite_accepted: true },
    { restaurant_id: RIVIERA_ID, user_id: waiterId, role: 'waiter', invite_accepted: true },
    { restaurant_id: RIVIERA_ID, user_id: kitchenId, role: 'kitchen', invite_accepted: true },
  ])

  const { data: staff, error: staffErr } = await dbAdmin
    .from('staff_members')
    .insert({ restaurant_id: RIVIERA_ID, email: waiterEmail, role: 'waiter', active: true })
    .select('id')
    .single()
  if (staffErr) throw staffErr
  waiterStaffId = staff.id

  const { data: leakRest, error: leakErr } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} leak B`, slug: `${tag}-leak-b`, owner_id: ownerBId })
    .select('id')
    .single()
  if (leakErr) throw leakErr
  restBId = leakRest.id

  await dbAdmin.from('restaurant_users').insert({
    restaurant_id: restBId,
    user_id: ownerBId,
    role: 'owner',
    invite_accepted: true,
  })

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
  if (createdInviteId) {
    await dbAdmin.from('staff_invites').delete().eq('id', createdInviteId)
  }
  if (waiterStaffId) {
    await dbAdmin.from('staff_permissions').delete().eq('staff_id', waiterStaffId)
    await dbAdmin.from('staff_members').delete().eq('id', waiterStaffId)
  }
  if (inviteBId) await dbAdmin.from('staff_invites').delete().eq('id', inviteBId)
  for (const uid of [managerId, waiterId, kitchenId]) {
    if (uid) {
      await dbAdmin.from('restaurant_users').delete().eq('user_id', uid)
      await dbAdmin.from('users').delete().eq('id', uid)
      await authAdmin.auth.admin.deleteUser(uid).catch(() => undefined)
    }
  }
  if (restBId) {
    await dbAdmin.from('staff_invites').delete().eq('restaurant_id', restBId)
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', restBId)
    await dbAdmin.from('restaurants').delete().eq('id', restBId)
  }
  if (ownerBId) {
    await dbAdmin.from('users').delete().eq('id', ownerBId)
    await authAdmin.auth.admin.deleteUser(ownerBId).catch(() => undefined)
  }
}

async function main() {
  const expectedPrefix = process.env.EXPECTED_COMMIT_PREFIX || 'd2d82ca'
  const versionRes = await fetch(`${APP}/api/version`)
  const versionBody = (await versionRes.json()) as { commit?: string }
  const commit = versionBody.commit ?? ''
  console.log(`Production commit: ${commit}`)
  if (!commit.startsWith(expectedPrefix.slice(0, 7))) {
    throw new Error(`Deploy not ready: expected ${expectedPrefix.slice(0, 7)}, got ${commit}`)
  }

  const report: Record<string, unknown> = { app: APP, tag, commit }

  try {
    await cleanupLeftovers()
    await setup()

    const ownerTok = await ownerToken()
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
        email: `${tag}.owner-invite@flashtap-test.invalid`,
        role: 'waiter',
      }),
    })
    const ownerInvitePostBody = await ownerInvitePost.json().catch(() => ({}))
    createdInviteId = (ownerInvitePostBody as { invite?: { id?: string } }).invite?.id ?? null

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
    const managerRoleApi = await fetchRoleApi(managerTok)

    const waiterStaffGet = await fetch(`${APP}/api/admin/staff`, {
      headers: { Authorization: `Bearer ${waiterTok}` },
    })
    const waiterStaffPage = await fetchStaffPage(waiterTok)

    const kitchenStaffGet = await fetch(`${APP}/api/admin/staff`, {
      headers: { Authorization: `Bearer ${kitchenTok}` },
    })
    const kitchenStaffPage = await fetchStaffPage(kitchenTok)

    await dbAdmin.from('staff_permissions').insert({
      staff_id: waiterStaffId,
      restaurant_id: RIVIERA_ID,
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
    const overrideInvitePost = await fetch(`${APP}/api/admin/invites`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${overrideTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: `${tag}.override-invite@flashtap-test.invalid`,
        role: 'waiter',
      }),
    })
    if (overrideInvitePost.ok) {
      const body = await overrideInvitePost.json().catch(() => ({}))
      const id = (body as { invite?: { id?: string } }).invite?.id
      if (id) await dbAdmin.from('staff_invites').delete().eq('id', id)
    }

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
      hasStaffManage: (managerRoleApi.body.permissions ?? []).includes(PERMISSIONS.STAFF_MANAGE),
    }
    report.waiter = {
      staffGet: waiterStaffGet.status,
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
      invitePost: overrideInvitePost.status,
    }
    report.crossTenantInvites = {
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
      w.staffPageRscRedirect === true &&
      k.staffGet === 403 &&
      k.staffPageRscRedirect === true &&
      ov.hasStaffManage === true &&
      ov.staffGet === 200 &&
      ov.invitesGet === 200 &&
      ov.invitePost === 200 &&
      x.leakedBInvite === false &&
      x.crossDeleteStatus === 403

    if (!pass) {
      console.error('STAFF_PRODUCTION_FAIL')
      process.exitCode = 1
    } else {
      console.log('STAFF_PRODUCTION_OK')
    }
  } finally {
    await cleanup()
    await cleanupLeftovers()
    console.log('Cleanup complete.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
