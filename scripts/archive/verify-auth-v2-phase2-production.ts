/**
 * Production verification for Authorization v2 Phase 2 (post deploy 46db312).
 * Run: npx tsx scripts/verify-auth-v2-phase2-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.production.local', override: true })

const APP = 'https://www.flashtap.app'
const OWNER_EMAIL = 'flashtaptestacc1@gmail.com'
const EXPECTED_COMMIT_PREFIX = '46db312'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !serviceKey) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const testEmail = `phase2.kitchen.verify.${Date.now()}@flashtap-test.invalid`
const testPassword = `Verify${randomUUID().slice(0, 8)}!1`
const testName = 'Phase2 Kitchen Verify'

let testUserId: string | null = null
let inviteId: string | null = null
let staffMemberId: string | null = null

async function ownerSession(): Promise<{ token: string; userId: string }> {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: OWNER_EMAIL,
  })
  if (linkErr || !link?.properties?.hashed_token) {
    throw new Error(`Owner magic link failed: ${linkErr?.message}`)
  }
  const { data: sess, error: otpErr } = await admin.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'magiclink',
  })
  if (otpErr || !sess.session?.access_token || !sess.user?.id) {
    throw new Error(`Owner OTP failed: ${otpErr?.message}`)
  }
  return { token: sess.session.access_token, userId: sess.user.id }
}

async function signIn(email: string, password: string): Promise<string> {
  const { data, error } = await admin.auth.signInWithPassword({ email, password })
  if (error || !data.session?.access_token) {
    throw new Error(`Sign-in failed for ${email}: ${error?.message}`)
  }
  return data.session.access_token
}

async function fetchStatus(path: string, token?: string): Promise<number> {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${APP}${path}`, { headers, redirect: 'manual' })
  return res.status
}

async function main() {
  const report: Record<string, unknown> = {}

  const versionRes = await fetch(`${APP}/api/version`)
  const versionJson = (await versionRes.json()) as { commit?: string }
  report.version = {
    status: versionRes.status,
    commit: versionJson.commit,
    ok: versionRes.status === 200 && versionJson.commit?.startsWith(EXPECTED_COMMIT_PREFIX),
  }

  const { token: ownerAccess, userId: ownerUserId } = await ownerSession()

  const { data: ownerMembership } = await admin
    .from('restaurant_users')
    .select('restaurant_id, role, restaurants(name)')
    .eq('user_id', ownerUserId)
    .maybeSingle()

  const restaurantId = String(ownerMembership?.restaurant_id || '')
  if (!restaurantId) throw new Error('Owner has no restaurant membership')

  report.owner = {
    restaurantId,
    restaurantName: (ownerMembership as { restaurants?: { name?: string } })?.restaurants?.name,
    pages: {
      stock: await fetchStatus('/stock', ownerAccess),
      menu: await fetchStatus('/menu-management', ownerAccess),
      settings: await fetchStatus('/settings', ownerAccess),
      staff: await fetchStatus('/staff', ownerAccess),
    },
  }

  const ownerPages = (report.owner as { pages: Record<string, number> }).pages
  const ownerPagesOk = Object.values(ownerPages).every((s) => s >= 200 && s < 400)
  ;(report.owner as { pagesOk?: boolean }).pagesOk = ownerPagesOk

  const inviteToken = randomUUID()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: inviteRow, error: inviteInsertErr } = await admin
    .from('staff_invites')
    .insert({
      restaurant_id: restaurantId,
      email: testEmail,
      role: 'waiter',
      token: inviteToken,
      expires_at: expiresAt,
      invited_by: ownerUserId,
      accepted: false,
    })
    .select('id')
    .single()

  if (inviteInsertErr || !inviteRow?.id) {
    throw new Error(`Invite insert failed: ${inviteInsertErr?.message}`)
  }
  inviteId = String(inviteRow.id)

  const acceptRes = await fetch(`${APP}/api/auth/invite/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: inviteToken,
      fullName: testName,
      password: testPassword,
    }),
  })
  const acceptJson = (await acceptRes.json()) as { success?: boolean; error?: string }
  if (!acceptRes.ok || !acceptJson.success) {
    throw new Error(`Invite accept failed: ${acceptJson.error ?? acceptRes.status}`)
  }

  const { data: testUserRow } = await admin.from('users').select('id').eq('email', testEmail).maybeSingle()
  testUserId = testUserRow?.id ? String(testUserRow.id) : null
  if (!testUserId) throw new Error('Test user not found after invite accept')

  const patchRes = await fetch(`${APP}/api/admin/staff/${testUserId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerAccess}`,
    },
    body: JSON.stringify({ role: 'kitchen' }),
  })
  const patchJson = (await patchRes.json()) as { success?: boolean; error?: string }
  if (!patchRes.ok || !patchJson.success) {
    throw new Error(`Staff PATCH to kitchen failed: ${patchJson.error ?? patchRes.status}`)
  }

  const { data: staffRow } = await admin
    .from('staff_members')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .ilike('email', testEmail)
    .maybeSingle()
  staffMemberId = staffRow?.id ? String(staffRow.id) : null

  const testToken = await signIn(testEmail, testPassword)
  const roleRes = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${testToken}` },
  })
  const roleJson = (await roleRes.json()) as { role?: string | null; restaurant_id?: string | null }

  const kitchenPages = {
    orders: await fetchStatus('/orders', testToken),
    stock: await fetchStatus('/stock', testToken),
    menu: await fetchStatus('/menu-management', testToken),
    staff: await fetchStatus('/staff', testToken),
  }

  report.kitchen = {
    patchStatus: patchRes.status,
    roleStatus: roleRes.status,
    role: roleJson.role,
    restaurant_id: roleJson.restaurant_id,
    roleOk: roleRes.status === 200 && roleJson.role === 'kitchen',
    pages: kitchenPages,
    pagesOk:
      kitchenPages.orders >= 200 &&
      kitchenPages.orders < 400 &&
      kitchenPages.stock >= 200 &&
      kitchenPages.stock < 400 &&
      (kitchenPages.menu === 403 || kitchenPages.menu === 302 || kitchenPages.menu === 307) &&
      (kitchenPages.staff === 403 || kitchenPages.staff === 302 || kitchenPages.staff === 307),
  }

  console.log(JSON.stringify(report, null, 2))

  const allOk =
    (report.version as { ok?: boolean }).ok &&
    ownerPagesOk &&
    (report.kitchen as { roleOk?: boolean; pagesOk?: boolean }).roleOk &&
    (report.kitchen as { pagesOk?: boolean }).pagesOk

  if (!allOk) process.exit(1)
}

async function cleanup() {
  if (staffMemberId) {
    await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId)
    await admin.from('staff_members').delete().eq('id', staffMemberId)
  }
  if (testUserId) {
    await admin.from('restaurant_users').delete().eq('user_id', testUserId)
    await admin.from('users').delete().eq('id', testUserId)
    await admin.auth.admin.deleteUser(testUserId).catch(() => {})
  }
  if (inviteId) {
    await admin.from('staff_invites').delete().eq('id', inviteId)
  }
}

main()
  .catch(async (err) => {
    console.error('Verification failed:', err)
    await cleanup()
    process.exit(1)
  })
  .then(async () => {
    await cleanup()
    console.log('\nCleanup complete.')
  })
