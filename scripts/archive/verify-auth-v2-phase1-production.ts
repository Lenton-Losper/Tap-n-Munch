/**
 * Production verification for Authorization v2 Phase 1 (post deploy 0d52a13).
 * Run: npx tsx scripts/verify-auth-v2-phase1-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.production.local' })

const APP = 'https://www.flashtap.app'
const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const OWNER_EMAIL = 'flashtaptestacc1@gmail.com'
const EXPECTED_COMMIT_PREFIX = '0d52a13'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !serviceKey) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const testEmail = `phase1.cashier.verify.${Date.now()}@flashtap-test.invalid`
const testPassword = `Verify${randomUUID().slice(0, 8)}!1`
const testName = 'Phase1 Cashier Verify'

let testUserId: string | null = null
let inviteId: string | null = null

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

async function main() {
  const report: Record<string, unknown> = {}

  // 1. Version
  const versionRes = await fetch(`${APP}/api/version`)
  const versionJson = (await versionRes.json()) as { commit?: string }
  report.version = {
    status: versionRes.status,
    commit: versionJson.commit,
    ok: versionRes.status === 200 && versionJson.commit?.startsWith(EXPECTED_COMMIT_PREFIX),
  }

  // 2. Health
  const healthUrls = [
    `${APP}/`,
    `${APP}/signin`,
    `${APP}/api/menu/${RIVIERA_ID}/features`,
    `${APP}/dashboard`,
  ]
  report.health = {}
  for (const u of healthUrls) {
    const res = await fetch(u, { redirect: 'manual' })
    ;(report.health as Record<string, unknown>)[u] = res.status
  }

  // 4. CHECK constraints (via disposable insert/delete on staff_members)
  const barEmail = `bar.check.${Date.now()}@test.invalid`
  const { data: barRow, error: barInsertError } = await admin
    .from('staff_members')
    .insert({
      restaurant_id: RIVIERA_ID,
      email: barEmail,
      role: 'bar',
      active: false,
    })
    .select('id')
    .single()

  let barConstraintOk = !barInsertError
  if (barRow?.id) {
    await admin.from('staff_members').delete().eq('id', barRow.id)
  }

  const cashierEmail = `cashier.check.${Date.now()}@test.invalid`
  const { data: cashierRow, error: cashierInsertError } = await admin
    .from('staff_members')
    .insert({
      restaurant_id: RIVIERA_ID,
      email: cashierEmail,
      role: 'cashier',
      active: false,
    })
    .select('id')
    .single()

  let cashierConstraintOk = !cashierInsertError
  if (cashierRow?.id) {
    await admin.from('staff_members').delete().eq('id', cashierRow.id)
  }

  report.constraints = {
    barInsertOk: barConstraintOk,
    cashierInsertOk: cashierConstraintOk,
    barError: barInsertError?.message ?? null,
    cashierError: cashierInsertError?.message ?? null,
  }

  // 3. Cashier PATCH flow
  const { token: ownerAccess, userId: ownerUserId } = await ownerSession()

  const { data: ownerMembership } = await admin
    .from('restaurant_users')
    .select('restaurant_id, role, restaurants(name)')
    .eq('user_id', ownerUserId)
    .maybeSingle()

  const restaurantId = String(ownerMembership?.restaurant_id || RIVIERA_ID)

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
    body: JSON.stringify({ role: 'cashier' }),
  })
  const patchJson = (await patchRes.json()) as { success?: boolean; error?: string }
  if (!patchRes.ok || !patchJson.success) {
    throw new Error(`Staff PATCH failed: ${patchJson.error ?? patchRes.status}`)
  }

  const testToken = await signIn(testEmail, testPassword)
  const roleRes = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${testToken}` },
  })
  const roleJson = (await roleRes.json()) as { role?: string | null; restaurant_id?: string | null }

  report.cashier = {
    restaurantId,
    restaurantName: (ownerMembership as { restaurants?: { name?: string } })?.restaurants?.name,
    patchStatus: patchRes.status,
    roleStatus: roleRes.status,
    role: roleJson.role,
    restaurant_id: roleJson.restaurant_id,
    roleOk: roleRes.status === 200 && roleJson.role === 'cashier',
  }

  console.log(JSON.stringify(report, null, 2))

  const allOk =
    (report.version as { ok?: boolean }).ok &&
    Object.values(report.health as Record<string, number>).every((s) => s >= 200 && s < 400) &&
    barConstraintOk &&
    cashierConstraintOk &&
    (report.cashier as { roleOk?: boolean }).roleOk

  if (!allOk) process.exit(1)
}

async function cleanup() {
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
