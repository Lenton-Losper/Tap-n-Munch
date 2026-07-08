/**
 * Staging verification for Authorization v2 Phase 3 (hasPermission + Stock sidebar).
 *   npx tsx scripts/verify-auth-v2-phase3-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { PERMISSIONS } from '../lib/permissions'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: '.env.test', override: true })

const STAGING_TEST_PASSWORD = requireStagingTestPassword()

const STAGING_APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_TEST_USER_ID = 'e65059f8-0727-4c9f-a268-4661eadb0325'
const STAGING_TEST_EMAIL = 'staging.kitchen.test@gmail.com'
const STAGING_TEST_RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.SUPABASE_ANON_KEY!

if (!url?.includes('mdqjpxwczrhkxkbqatqa')) {
  throw new Error('Refusing to run: not staging Supabase')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const anon = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function signIn(): Promise<string> {
  const { data, error } = await anon.auth.signInWithPassword({
    email: STAGING_TEST_EMAIL,
    password: STAGING_TEST_PASSWORD,
  })
  if (error || !data.session?.access_token) {
    throw new Error(`Sign-in failed: ${error?.message}`)
  }
  return data.session.access_token
}

async function fetchRoleApi(token: string) {
  const res = await fetch(`${STAGING_APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json()
  return { status: res.status, body }
}

async function ensureStaffMemberId(): Promise<string> {
  const { data: existing } = await admin
    .from('staff_members')
    .select('id')
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
    .ilike('email', STAGING_TEST_EMAIL)
    .maybeSingle()

  if (existing?.id) return String(existing.id)

  const { data: inserted, error } = await admin
    .from('staff_members')
    .insert({
      restaurant_id: STAGING_TEST_RESTAURANT_ID,
      email: STAGING_TEST_EMAIL,
      role: 'kitchen',
      active: true,
    })
    .select('id')
    .single()

  if (error) throw error
  return String(inserted.id)
}

async function setRole(role: string) {
  const { error } = await admin
    .from('restaurant_users')
    .update({ role, updated_at: new Date().toISOString() })
    .eq('user_id', STAGING_TEST_USER_ID)
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
  if (error) throw error
  await admin
    .from('staff_members')
    .update({ role })
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
    .ilike('email', STAGING_TEST_EMAIL)
}

async function clearOverrides(staffMemberId: string) {
  await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId)
}

function stockVisibleForPermissions(permissions: string[]): boolean {
  return permissions.includes(PERMISSIONS.STOCK_VIEW)
}

function navVisibleForRole(role: string, permissions: string[]): Record<string, boolean> {
  const roleNav: Record<string, string[]> = {
    '/dashboard': ['owner', 'manager', 'waiter', 'kitchen', 'bar'],
    '/dashboard/order-history': ['owner', 'manager'],
    '/qr-codes': ['owner', 'manager'],
    '/menu-management': ['owner', 'manager'],
    '/staff': ['owner', 'manager'],
    '/analytics': ['owner', 'manager'],
    '/stock': ['owner', 'manager', 'kitchen', 'bar'],
    '/settings': ['owner'],
  }

  const result: Record<string, boolean> = {}
  for (const [href, roles] of Object.entries(roleNav)) {
    if (href === '/stock') {
      result[href] = stockVisibleForPermissions(permissions)
    } else {
      result[href] = roles.includes(role)
    }
  }
  return result
}

async function main() {
  const report: Record<string, unknown> = {}
  const staffMemberId = await ensureStaffMemberId()
  const originalRole = 'kitchen'

  try {
    await clearOverrides(staffMemberId)
    await setRole('kitchen')

    const kitchenToken = await signIn()
    const kitchenRoleApi = await fetchRoleApi(kitchenToken)
    report.kitchen = {
      status: kitchenRoleApi.status,
      role: kitchenRoleApi.body.role,
      hasStockView: kitchenRoleApi.body.permissions?.includes(PERMISSIONS.STOCK_VIEW),
      stockNavVisible: stockVisibleForPermissions(kitchenRoleApi.body.permissions ?? []),
    }

    await setRole('waiter')
    const waiterToken = await signIn()
    const waiterRoleApi = await fetchRoleApi(waiterToken)
    report.waiter = {
      status: waiterRoleApi.status,
      role: waiterRoleApi.body.role,
      hasStockView: waiterRoleApi.body.permissions?.includes(PERMISSIONS.STOCK_VIEW),
      stockNavVisible: stockVisibleForPermissions(waiterRoleApi.body.permissions ?? []),
    }

    const { error: allowError } = await admin.from('staff_permissions').insert({
      staff_id: staffMemberId,
      restaurant_id: STAGING_TEST_RESTAURANT_ID,
      permission: PERMISSIONS.STOCK_VIEW,
      effect: 'allow',
    })
    if (allowError) throw allowError

    const waiterOverrideToken = await signIn()
    const waiterOverrideApi = await fetchRoleApi(waiterOverrideToken)
    report.waiterWithStockOverride = {
      status: waiterOverrideApi.status,
      role: waiterOverrideApi.body.role,
      hasStockView: waiterOverrideApi.body.permissions?.includes(PERMISSIONS.STOCK_VIEW),
      stockNavVisible: stockVisibleForPermissions(waiterOverrideApi.body.permissions ?? []),
    }

    const otherNavUnchanged =
      JSON.stringify(
        navVisibleForRole('waiter', waiterRoleApi.body.permissions ?? []),
      ) ===
      JSON.stringify({
        '/dashboard': true,
        '/dashboard/order-history': false,
        '/qr-codes': false,
        '/menu-management': false,
        '/staff': false,
        '/analytics': false,
        '/stock': false,
        '/settings': false,
      })

    report.otherNavUnchangedForWaiter = otherNavUnchanged

    await clearOverrides(staffMemberId)
    await setRole('waiter')
    const waiterNoPermToken = await signIn()
    const stockPageRes = await fetch(`${STAGING_APP}/stock`, {
      headers: { Authorization: `Bearer ${waiterNoPermToken}` },
      redirect: 'manual',
    })
    report.serverEnforcement = {
      waiterDirectStockStatus: stockPageRes.status,
      waiterDirectStockLocation: stockPageRes.headers.get('location'),
      blocked:
        stockPageRes.status === 307 ||
        stockPageRes.status === 302 ||
        stockPageRes.headers.get('location')?.includes('/dashboard'),
    }

    console.log(JSON.stringify(report, null, 2))

    const allOk =
      kitchenRoleApi.body.permissions?.includes(PERMISSIONS.STOCK_VIEW) &&
      !waiterRoleApi.body.permissions?.includes(PERMISSIONS.STOCK_VIEW) &&
      waiterOverrideApi.body.permissions?.includes(PERMISSIONS.STOCK_VIEW) &&
      otherNavUnchanged &&
      report.serverEnforcement &&
      (report.serverEnforcement as { blocked?: boolean }).blocked

    if (!allOk) process.exit(1)
  } finally {
    await clearOverrides(staffMemberId)
    await setRole(originalRole)
    console.log('\nCleanup complete (role restored to kitchen, overrides removed).')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
