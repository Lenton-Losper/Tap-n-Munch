/**
 * Production verification for Authorization v2 Phase 3.
 *   npx tsx scripts/verify-auth-v2-phase3-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { PERMISSIONS } from '../lib/permissions'

config({ path: '.env.production.local', override: true })

const APP = 'https://www.flashtap.app'
const OWNER_EMAIL = 'flashtaptestacc1@gmail.com'
const EXPECTED_COMMIT_PREFIX = '575fefd'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url.includes('ihlmmpmolnpchzgwyhgh')) {
  throw new Error('Refusing to run: not production Supabase')
}

function createAdminClient() {
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

const admin = createAdminClient()

const testEmail = `phase3.waiter.verify.${Date.now()}@flashtap-test.invalid`
const testPassword = `Verify${randomUUID().slice(0, 8)}!1`
const testName = 'Phase3 Waiter Verify'

let testUserId: string | null = null
let inviteId: string | null = null
let staffMemberId: string | null = null

async function ownerSession(): Promise<{ token: string; userId: string }> {
  const authClient = createAdminClient()
  const { data: link, error: linkErr } = await authClient.auth.admin.generateLink({
    type: 'magiclink',
    email: OWNER_EMAIL,
  })
  if (linkErr || !link?.properties?.hashed_token) {
    throw new Error(`Owner magic link failed: ${linkErr?.message}`)
  }
  const { data: sess, error: otpErr } = await authClient.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'magiclink',
  })
  if (otpErr || !sess.session?.access_token || !sess.user?.id) {
    throw new Error(`Owner OTP failed: ${otpErr?.message}`)
  }
  return { token: sess.session.access_token, userId: sess.user.id }
}

async function signIn(email: string, password: string): Promise<string> {
  const authClient = createAdminClient()
  const { data, error } = await authClient.auth.signInWithPassword({ email, password })
  if (error || !data.session?.access_token) {
    throw new Error(`Sign-in failed for ${email}: ${error?.message}`)
  }
  return data.session.access_token
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

  const { token: ownerToken } = await ownerSession()
  const ownerRoleRes = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  })
  const ownerRoleJson = (await ownerRoleRes.json()) as {
    role?: string
    restaurant_id?: string
    permissions?: string[]
  }
  report.ownerRoleApi = {
    status: ownerRoleRes.status,
    role: ownerRoleJson.role,
    hasPermissionsArray: Array.isArray(ownerRoleJson.permissions),
    permissionCount: ownerRoleJson.permissions?.length ?? 0,
    hasStockView: ownerRoleJson.permissions?.includes(PERMISSIONS.STOCK_VIEW),
    ok:
      ownerRoleRes.status === 200 &&
      ownerRoleJson.role === 'owner' &&
      Array.isArray(ownerRoleJson.permissions) &&
      (ownerRoleJson.permissions?.length ?? 0) > 0,
  }

  const { token: ownerAccess, userId: ownerUserId } = await ownerSession()
  const { data: ownerMembership } = await admin
    .from('restaurant_users')
    .select('restaurant_id, restaurants(name)')
    .eq('user_id', ownerUserId)
    .maybeSingle()

  const restaurantId = String(ownerMembership?.restaurant_id || '')
  if (!restaurantId) throw new Error('Owner has no restaurant membership')

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

  const { data: staffRow, error: staffInsertErr } = await admin
    .from('staff_members')
    .insert({
      restaurant_id: restaurantId,
      email: testEmail,
      role: 'waiter',
      active: true,
    })
    .select('id')
    .single()

  if (staffInsertErr || !staffRow?.id) {
    throw new Error(`staff_members insert failed: ${staffInsertErr?.message}`)
  }
  staffMemberId = String(staffRow.id)

  const waiterToken = await signIn(testEmail, testPassword)
  const waiterRoleRes = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${waiterToken}` },
  })
  const waiterRoleJson = (await waiterRoleRes.json()) as {
    role?: string
    permissions?: string[]
  }

  report.waiter = {
    restaurantId,
    restaurantName: (ownerMembership as { restaurants?: { name?: string } })?.restaurants?.name,
    role: waiterRoleJson.role,
    hasStockView: waiterRoleJson.permissions?.includes(PERMISSIONS.STOCK_VIEW),
    stockNavVisible: waiterRoleJson.permissions?.includes(PERMISSIONS.STOCK_VIEW),
    ok: waiterRoleJson.role === 'waiter' && !waiterRoleJson.permissions?.includes(PERMISSIONS.STOCK_VIEW),
  }

  const { error: allowErr } = await admin.from('staff_permissions').insert({
    staff_id: staffMemberId,
    restaurant_id: restaurantId,
    permission: PERMISSIONS.STOCK_VIEW,
    effect: 'allow',
  })
  if (allowErr) throw allowErr

  const waiterOverrideToken = await signIn(testEmail, testPassword)
  const waiterOverrideRes = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${waiterOverrideToken}` },
  })
  const waiterOverrideJson = (await waiterOverrideRes.json()) as { permissions?: string[] }

  report.waiterWithOverride = {
    hasStockView: waiterOverrideJson.permissions?.includes(PERMISSIONS.STOCK_VIEW),
    stockNavVisible: waiterOverrideJson.permissions?.includes(PERMISSIONS.STOCK_VIEW),
    ok: waiterOverrideJson.permissions?.includes(PERMISSIONS.STOCK_VIEW) === true,
  }

  await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId)

  const waiterNoOverrideToken = await signIn(testEmail, testPassword)
  const waiterRoleAfterCleanup = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${waiterNoOverrideToken}` },
  })
  const waiterAfterJson = (await waiterRoleAfterCleanup.json()) as { permissions?: string[] }

  report.afterOverrideRemoved = {
    hasStockView: waiterAfterJson.permissions?.includes(PERMISSIONS.STOCK_VIEW),
    ok: !waiterAfterJson.permissions?.includes(PERMISSIONS.STOCK_VIEW),
  }

  console.log(JSON.stringify(report, null, 2))

  const allOk =
    (report.version as { ok?: boolean }).ok &&
    (report.ownerRoleApi as { ok?: boolean }).ok &&
    (report.waiter as { ok?: boolean }).ok &&
    (report.waiterWithOverride as { ok?: boolean }).ok &&
    (report.afterOverrideRemoved as { ok?: boolean }).ok

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
