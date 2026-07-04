/**
 * Staging verification for Analytics permission migration + server enforcement.
 *   npx tsx scripts/verify-analytics-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import rolePermissionsConfig from '../lib/permissions/role-permissions.config.json'
import { PERMISSIONS } from '../lib/permissions'

config({ path: '.env.test', override: true })

const STAGING_APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RESTA = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const OWNER_EMAIL = 'flashtap.staging.test@gmail.com'
const OWNER_PASSWORD = '!Flash01'
const KITCHEN_USER_ID = 'e65059f8-0727-4c9f-a268-4661eadb0325'
const KITCHEN_EMAIL = 'staging.kitchen.test@gmail.com'
const KITCHEN_PASSWORD = '!Flash01'

const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.SUPABASE_ANON_KEY!

if (!url?.includes(STAGING_REF)) {
  throw new Error('Refusing to run: not staging Supabase')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const anon = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function sorted(arr: string[]): string[] {
  return [...arr].sort()
}

function expectedFromJson(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(rolePermissionsConfig).filter(([key]) => !key.startsWith('$')),
  ) as Record<string, string[]>
}

async function signIn(email: string, password: string): Promise<string> {
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session?.access_token) {
    throw new Error(`Sign-in failed for ${email}: ${error?.message}`)
  }
  return data.session.access_token
}

async function ensureStaffMemberId(email: string): Promise<string> {
  const { data: existing } = await admin
    .from('staff_members')
    .select('id')
    .eq('restaurant_id', RESTA)
    .ilike('email', email)
    .maybeSingle()
  if (existing?.id) return String(existing.id)

  const { data: inserted, error } = await admin
    .from('staff_members')
    .insert({
      restaurant_id: RESTA,
      email,
      role: 'waiter',
      active: true,
    })
    .select('id')
    .single()
  if (error) throw error
  return String(inserted.id)
}

async function setRole(userId: string, email: string, role: string) {
  await admin
    .from('restaurant_users')
    .update({ role, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('restaurant_id', RESTA)
  await admin.from('staff_members').update({ role }).eq('restaurant_id', RESTA).ilike('email', email)
}

async function clearOverrides(staffMemberId: string) {
  await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId)
}

async function fetchRoleApi(token: string) {
  const res = await fetch(`${STAGING_APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: res.status, body: await res.json() }
}

async function fetchAnalyticsApi(token: string, restaurantId: string) {
  const res = await fetch(
    `${STAGING_APP}/api/analytics/orders-summary?restaurantId=${encodeURIComponent(restaurantId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function fetchAnalyticsPage(token: string) {
  const res = await fetch(`${STAGING_APP}/analytics`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  })
  const body = await res.text()
  const location = res.headers.get('location')
  const rscRedirect =
    body.includes('NEXT_REDIRECT') &&
    (body.includes('/dashboard') || body.includes('/signin'))
  return { status: res.status, location, rscRedirect, body }
}

function analyticsNavVisible(permissions: string[]): boolean {
  return permissions.includes(PERMISSIONS.ANALYTICS_VIEW)
}

async function verifySeedFidelity() {
  const expected = expectedFromJson()
  const { data: restaurants } = await admin.from('restaurants').select('id, name')
  const { data: rows } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, permissions')

  const byRestaurant = new Map<string, NonNullable<typeof rows>>()
  for (const row of rows ?? []) {
    const list = byRestaurant.get(row.restaurant_id) ?? []
    list.push(row)
    byRestaurant.set(row.restaurant_id, list)
  }

  for (const restaurant of restaurants ?? []) {
    const roles = byRestaurant.get(restaurant.id) ?? []
    for (const slug of Object.keys(expected)) {
      const dbRow = roles.find((r) => r.role_slug === slug)
      if (!dbRow) throw new Error(`${restaurant.name}: missing role ${slug}`)
      const dbPerms = sorted((dbRow.permissions as string[]) ?? [])
      const jsonPerms = sorted(expected[slug] ?? [])
      if (JSON.stringify(dbPerms) !== JSON.stringify(jsonPerms)) {
        throw new Error(`${restaurant.name}: ${slug} permissions mismatch`)
      }
    }
  }
  console.log('OK: seed fidelity — all restaurants match role-permissions.config.json')
}

async function main() {
  const report: Record<string, unknown> = {}
  let restBId: string | null = null
  let restBOwnerId: string | null = null
  const staffMemberId = await ensureStaffMemberId(KITCHEN_EMAIL)

  try {
    await verifySeedFidelity()

    const ownerToken = await signIn(OWNER_EMAIL, OWNER_PASSWORD)
    const ownerRoleApi = await fetchRoleApi(ownerToken)
    report.owner = {
      hasAnalyticsView: ownerRoleApi.body.permissions?.includes(PERMISSIONS.ANALYTICS_VIEW),
      analyticsNavVisible: analyticsNavVisible(ownerRoleApi.body.permissions ?? []),
    }

    const ownerApi = await fetchAnalyticsApi(ownerToken, RESTA)
    report.ownerApi = { status: ownerApi.status, orderCount: ownerApi.body.orders?.length ?? 0 }

    await setRole(KITCHEN_USER_ID, KITCHEN_EMAIL, 'waiter')
    await clearOverrides(staffMemberId)
    const waiterToken = await signIn(KITCHEN_EMAIL, KITCHEN_PASSWORD)
    const waiterRoleApi = await fetchRoleApi(waiterToken)
    report.waiter = {
      hasAnalyticsView: waiterRoleApi.body.permissions?.includes(PERMISSIONS.ANALYTICS_VIEW),
      analyticsNavVisible: analyticsNavVisible(waiterRoleApi.body.permissions ?? []),
    }

    const waiterApi = await fetchAnalyticsApi(waiterToken, RESTA)
    const waiterPage = await fetchAnalyticsPage(waiterToken)
    report.waiterBlocked = {
      apiStatus: waiterApi.status,
      pageStatus: waiterPage.status,
      pageLocation: waiterPage.location,
      pageRscRedirect: waiterPage.rscRedirect,
    }

    await admin.from('staff_permissions').insert({
      staff_id: staffMemberId,
      restaurant_id: RESTA,
      permission: PERMISSIONS.ANALYTICS_VIEW,
      effect: 'allow',
    })

    const waiterOverrideToken = await signIn(KITCHEN_EMAIL, KITCHEN_PASSWORD)
    const waiterOverrideRoleApi = await fetchRoleApi(waiterOverrideToken)
    const waiterOverrideApi = await fetchAnalyticsApi(waiterOverrideToken, RESTA)
    const waiterOverridePage = await fetchAnalyticsPage(waiterOverrideToken)
    report.waiterOverride = {
      hasAnalyticsView: waiterOverrideRoleApi.body.permissions?.includes(PERMISSIONS.ANALYTICS_VIEW),
      analyticsNavVisible: analyticsNavVisible(waiterOverrideRoleApi.body.permissions ?? []),
      apiStatus: waiterOverrideApi.status,
      pageStatus: waiterOverridePage.status,
      pageRscRedirect: waiterOverridePage.rscRedirect,
    }

    const disposableEmail = `analytics-leak-${Date.now()}@staging-disposable.local`
    const { data: createdUser, error: createUserErr } = await admin.auth.admin.createUser({
      email: disposableEmail,
      password: '!Flash01',
      email_confirm: true,
    })
    if (createUserErr) throw createUserErr
    restBOwnerId = createdUser.user.id

    await admin.from('users').insert({
      id: restBOwnerId,
      email: disposableEmail,
      full_name: 'Analytics Leak Test',
      role: 'owner',
    })

    const { data: restB, error: restBErr } = await admin
      .from('restaurants')
      .insert({
        name: `analytics-leak-${Date.now()}`,
        owner_id: restBOwnerId,
        currency: 'NAD',
      })
      .select('id')
      .single()
    if (restBErr) throw restBErr
    restBId = restB.id

    await admin.from('restaurant_users').insert({
      restaurant_id: restBId,
      user_id: restBOwnerId,
      role: 'owner',
      invite_accepted: true,
    })

    const crossTenantApi = await fetchAnalyticsApi(ownerToken, restBId!)
    report.crossTenant = {
      status: crossTenantApi.status,
      orderCount: crossTenantApi.body.orders?.length ?? 0,
    }

    console.log(JSON.stringify(report, null, 2))

    const ok =
      report.owner &&
      (report.owner as { hasAnalyticsView?: boolean }).hasAnalyticsView &&
      (report.ownerApi as { status?: number }).status === 200 &&
      !(report.waiter as { hasAnalyticsView?: boolean }).hasAnalyticsView &&
      (report.waiterBlocked as { apiStatus?: number }).apiStatus === 403 &&
      (((report.waiterBlocked as { pageStatus?: number }).pageStatus === 307 ||
        (report.waiterBlocked as { pageStatus?: number }).pageStatus === 302 ||
        String((report.waiterBlocked as { pageLocation?: string }).pageLocation || '').includes(
          '/dashboard',
        )) ||
        (report.waiterBlocked as { pageRscRedirect?: boolean }).pageRscRedirect) &&
      (report.waiterOverride as { hasAnalyticsView?: boolean }).hasAnalyticsView &&
      (report.waiterOverride as { apiStatus?: number }).apiStatus === 200 &&
      ((report.waiterOverride as { pageStatus?: number }).pageStatus === 200 &&
        !(report.waiterOverride as { pageRscRedirect?: boolean }).pageRscRedirect) &&
      (report.crossTenant as { status?: number }).status === 403

    if (!ok) {
      console.error('FAIL: analytics staging verification')
      process.exit(1)
    }
    console.log('\nANALYTICS_STAGING_OK')
  } finally {
    await clearOverrides(staffMemberId)
    await setRole(KITCHEN_USER_ID, KITCHEN_EMAIL, 'kitchen')
    if (restBId) {
      await admin.from('restaurant_users').delete().eq('restaurant_id', restBId)
      await admin.from('restaurants').delete().eq('id', restBId)
    }
    if (restBOwnerId) {
      await admin.from('users').delete().eq('id', restBOwnerId)
      await admin.auth.admin.deleteUser(restBOwnerId)
    }
    console.log('Cleanup complete.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
