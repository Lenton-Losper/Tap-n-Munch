/**
 * Phase 4B production verification (Riviera real owner + disposable test staff).
 *   npx tsx scripts/verify-phase4b-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { isStaffAssignableRole } from '../lib/restaurant-roles/assignable'

config({ path: '.env.production.local', override: true })

const APP = process.env.PRODUCTION_APP_URL || 'https://www.flashtap.app'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const tag = `phase4b-prod-${Date.now()}`
const pw = `Verify${randomUUID().slice(0, 8)}!1`

const LEGACY_ASSIGNABLE = ['cashier', 'kitchen', 'manager', 'waiter']
const LEGACY_INVITE_ELIGIBLE = ['manager', 'waiter']

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
let inviteManagerId: string | null = null
let inviteWaiterId: string | null = null
const disposableEmail = `${tag}.waiter@flashtap-test.invalid`

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

async function setupDisposableWaiter() {
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
    full_name: 'Phase4B Disposable',
  })

  await dbAdmin.from('restaurant_users').insert({
    restaurant_id: RIVIERA_ID,
    user_id: disposableUserId,
    role: 'waiter',
    invite_accepted: true,
  })
}

async function cleanup() {
  if (inviteManagerId) await dbAdmin.from('staff_invites').delete().eq('id', inviteManagerId)
  if (inviteWaiterId) await dbAdmin.from('staff_invites').delete().eq('id', inviteWaiterId)
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

async function cleanupLeftovers() {
  const { data: users } = await dbAdmin
    .from('users')
    .select('id, email')
    .like('email', 'phase4b-prod-%')
  for (const row of users ?? []) {
    await dbAdmin.from('restaurant_users').delete().eq('user_id', row.id)
    await dbAdmin.from('users').delete().eq('id', row.id)
    await authAdmin.auth.admin.deleteUser(row.id).catch(() => undefined)
  }
  await dbAdmin.from('staff_invites').delete().like('email', 'phase4b-prod-%')
}

async function main() {
  const expectedPrefix = process.env.EXPECTED_COMMIT_PREFIX || '9d99447'
  const versionRes = await fetch(`${APP}/api/version`)
  const versionBody = (await versionRes.json()) as { commit?: string }
  const commit = versionBody.commit ?? ''
  console.log(`Production commit: ${commit}`)
  if (!commit.startsWith(expectedPrefix.slice(0, 7))) {
    throw new Error(`Deploy not ready: expected prefix ${expectedPrefix.slice(0, 7)}, got ${commit}`)
  }

  const report: Record<string, unknown> = { app: APP, tag, commit, restaurant: 'Riviera' }

  await cleanupLeftovers()
  await setupDisposableWaiter()

  const ownerTok = await ownerToken()

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

  const patchKitchen = await fetch(`${APP}/api/admin/staff/${disposableUserId}`, {
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
    .eq('user_id', disposableUserId!)
    .eq('restaurant_id', RIVIERA_ID)
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

  const patchBar = await fetch(`${APP}/api/admin/staff/${disposableUserId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'bar' }),
  })
  report.barPatchRejected = patchBar.status

  console.log(JSON.stringify(report, null, 2))

  const pass =
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
    console.error('PHASE4B_PRODUCTION_FAIL')
    process.exitCode = 1
  } else {
    console.log('PHASE4B_PRODUCTION_OK')
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
