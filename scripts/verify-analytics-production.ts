/**
 * Production Step 3 verification for Analytics permission + server enforcement.
 *   npx tsx scripts/verify-analytics-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { PERMISSIONS } from '../lib/permissions'

config({ path: '.env.production.local', override: true })

const APP = 'https://www.flashtap.app'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const EXPECTED_COMMIT_PREFIX = '6991fbd'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

if (!url?.includes(PROD_REF)) throw new Error(`Refusing: not production Supabase (${url})`)

/** DB mutations/queries — never call auth.* on this client (verifyOtp poisons the session). */
const dbAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/** Auth admin API only — generateLink, verifyOtp, createUser, deleteUser. */
const authAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const anon = createClient(url, anonKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const testEmail = `analytics.prod.verify.${Date.now()}@flashtap-test.invalid`
const testPassword = `Verify${randomUUID().slice(0, 8)}!1`

let testUserId: string | null = null
let testStaffMemberId: string | null = null
let restBId: string | null = null
let restBOwnerId: string | null = null

async function resolveRivieraOwnerEmail(): Promise<string> {
  const { data: ownerRow, error } = await dbAdmin
    .from('restaurant_users')
    .select('user_id')
    .eq('restaurant_id', RIVIERA_ID)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!ownerRow?.user_id) throw new Error('No Riviera owner in restaurant_users')

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

async function signIn(email: string, password: string): Promise<string> {
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session?.access_token) {
    throw new Error(`Sign-in failed for ${email}: ${error?.message}`)
  }
  return data.session.access_token
}

async function fetchAnalyticsApi(token: string, restaurantId: string) {
  const res = await fetch(
    `${APP}/api/analytics/orders-summary?restaurantId=${encodeURIComponent(restaurantId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const body = await res.json().catch(() => ({}))
  return {
    status: res.status,
    orderCount: Array.isArray(body.orders) ? body.orders.length : null,
    error: body.error as string | undefined,
  }
}

async function fetchAnalyticsPage(token: string) {
  const res = await fetch(`${APP}/analytics`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  })
  const body = await res.text()
  const location = res.headers.get('location')
  const rscRedirect =
    body.includes('NEXT_REDIRECT') &&
    (body.includes('/dashboard') || body.includes('/signin'))
  return { status: res.status, location, rscRedirect }
}

async function fetchRoleApi(token: string) {
  const res = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: res.status, body: await res.json() }
}

async function cleanupLeftoverVerifyAccounts() {
  const { data: leftovers } = await dbAdmin
    .from('users')
    .select('id, email')
    .or('email.like.analytics.prod.verify%,email.like.analytics.prod.ui%,email.like.analytics-leak-prod%')

  for (const row of leftovers ?? []) {
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
    await authAdmin.auth.admin.deleteUser(row.id)
  }

  const { data: leakRestaurants } = await dbAdmin
    .from('restaurants')
    .select('id, owner_id')
    .like('name', 'analytics-leak-prod-%')
  for (const leak of leakRestaurants ?? []) {
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', leak.id)
    await dbAdmin.from('restaurants').delete().eq('id', leak.id)
    if (leak.owner_id) {
      await dbAdmin.from('users').delete().eq('id', leak.owner_id)
      await authAdmin.auth.admin.deleteUser(String(leak.owner_id)).catch(() => undefined)
    }
  }
}

async function createDisposableWaiterOnRiviera(): Promise<void> {
  const { data: created, error: createErr } = await authAdmin.auth.admin.createUser({
    email: testEmail,
    password: testPassword,
    email_confirm: true,
  })
  if (createErr) throw createErr
  testUserId = created.user.id

  const { error: userErr } = await dbAdmin.from('users').insert({
    id: testUserId,
    email: testEmail,
    full_name: 'Analytics Prod Verify Waiter',
    role: 'waiter',
  })
  if (userErr) throw userErr

  const { error: ruErr } = await dbAdmin.from('restaurant_users').insert({
    restaurant_id: RIVIERA_ID,
    user_id: testUserId,
    role: 'waiter',
    invite_accepted: true,
  })
  if (ruErr) throw ruErr

  const { data: staff, error: staffErr } = await dbAdmin
    .from('staff_members')
    .insert({
      restaurant_id: RIVIERA_ID,
      email: testEmail,
      role: 'waiter',
      active: true,
    })
    .select('id')
    .single()
  if (staffErr) throw staffErr
  testStaffMemberId = String(staff.id)
}

async function cleanupDisposableWaiter() {
  if (testStaffMemberId) {
    await dbAdmin.from('staff_permissions').delete().eq('staff_id', testStaffMemberId)
    await dbAdmin.from('staff_members').delete().eq('id', testStaffMemberId)
  }
  if (testUserId) {
    await dbAdmin.from('restaurant_users').delete().eq('user_id', testUserId)
    await dbAdmin.from('users').delete().eq('id', testUserId)
    await authAdmin.auth.admin.deleteUser(testUserId)
  }
  testStaffMemberId = null
  testUserId = null
}

async function cleanupRestB() {
  if (restBId) {
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', restBId)
    await dbAdmin.from('restaurants').delete().eq('id', restBId)
  }
  if (restBOwnerId) {
    await dbAdmin.from('users').delete().eq('id', restBOwnerId)
    await authAdmin.auth.admin.deleteUser(restBOwnerId)
  }
  restBId = null
  restBOwnerId = null
}

async function main() {
  const versionRes = await fetch(`${APP}/api/version`)
  const versionBody = (await versionRes.json()) as { commit?: string }
  const commit = versionBody.commit ?? ''
  console.log(`Production commit: ${commit}`)
  if (!commit.startsWith(EXPECTED_COMMIT_PREFIX)) {
    throw new Error(
      `Deploy not ready: expected commit prefix ${EXPECTED_COMMIT_PREFIX}, got ${commit}`,
    )
  }

  const report: Record<string, unknown> = {}

  try {
    await cleanupLeftoverVerifyAccounts()
    const ownerEmail = await resolveRivieraOwnerEmail()
    console.log(`Riviera owner email: ${ownerEmail}`)
    await createDisposableWaiterOnRiviera()

    const ownerTok = await ownerToken()
    report.ownerApi = await fetchAnalyticsApi(ownerTok, RIVIERA_ID)

    const waiterTok = await signIn(testEmail, testPassword)
    report.waiterRole = await fetchRoleApi(waiterTok)
    report.waiterApi = await fetchAnalyticsApi(waiterTok, RIVIERA_ID)
    report.waiterPage = await fetchAnalyticsPage(waiterTok)

    const { error: overrideErr } = await dbAdmin.from('staff_permissions').insert({
      staff_id: testStaffMemberId,
      restaurant_id: RIVIERA_ID,
      permission: PERMISSIONS.ANALYTICS_VIEW,
      effect: 'allow',
    })
    if (overrideErr) throw overrideErr

    const overrideTok = await signIn(testEmail, testPassword)
    report.waiterOverrideRole = await fetchRoleApi(overrideTok)
    report.waiterOverrideApi = await fetchAnalyticsApi(overrideTok, RIVIERA_ID)
    report.waiterOverridePage = await fetchAnalyticsPage(overrideTok)

    const disposableEmail = `analytics-leak-prod-${Date.now()}@flashtap-test.invalid`
    const { data: createdUser, error: createUserErr } = await authAdmin.auth.admin.createUser({
      email: disposableEmail,
      password: testPassword,
      email_confirm: true,
    })
    if (createUserErr) throw createUserErr
    restBOwnerId = createdUser.user.id

    await dbAdmin.from('users').insert({
      id: restBOwnerId,
      email: disposableEmail,
      full_name: 'Analytics Leak Prod',
      role: 'owner',
    })

    const { data: restB, error: restBErr } = await dbAdmin
      .from('restaurants')
      .insert({
        name: `analytics-leak-prod-${Date.now()}`,
        owner_id: restBOwnerId,
        currency: 'NAD',
      })
      .select('id')
      .single()
    if (restBErr) throw restBErr
    const leakRestaurantId = restB?.id
    if (!leakRestaurantId) {
      throw new Error('Cross-tenant leak restaurant B insert returned no id; aborting crossTenant test')
    }
    restBId = leakRestaurantId

    await dbAdmin.from('restaurant_users').insert({
      restaurant_id: leakRestaurantId,
      user_id: restBOwnerId,
      role: 'owner',
      invite_accepted: true,
    })

    report.crossTenant = await fetchAnalyticsApi(ownerTok, leakRestaurantId)

    console.log(JSON.stringify(report, null, 2))

    const waiterPage = report.waiterPage as {
      status?: number
      location?: string
      rscRedirect?: boolean
    }
    const waiterBlocked =
      (report.waiterApi as { status: number }).status === 403 &&
      (waiterPage.status === 307 ||
        waiterPage.status === 302 ||
        String(waiterPage.location || '').includes('/dashboard') ||
        waiterPage.rscRedirect === true)

    const ok =
      (report.ownerApi as { status: number }).status === 200 &&
      (report.waiterApi as { status: number }).status === 403 &&
      waiterBlocked &&
      (report.waiterOverrideRole as { body: { permissions?: string[] } }).body.permissions?.includes(
        PERMISSIONS.ANALYTICS_VIEW,
      ) &&
      (report.waiterOverrideApi as { status: number }).status === 200 &&
      (report.crossTenant as { status: number }).status === 403

    if (!ok) {
      console.error('FAIL: analytics production API verification')
      process.exit(1)
    }
    console.log('\nANALYTICS_PRODUCTION_API_OK')
  } finally {
    await cleanupDisposableWaiter()
    await cleanupRestB()
    console.log('Cleanup complete.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
