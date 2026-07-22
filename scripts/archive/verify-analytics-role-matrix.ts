/**
 * Step 5 supplement: role matrix for /api/analytics/orders-summary
 */
import { config } from 'dotenv'
config({ path: '.env.test', override: true })


const STAGING_TEST_PASSWORD = requireStagingTestPassword()

import { createClient } from '@supabase/supabase-js'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

const STAGING = 'https://flashtap-staging.llosperofficial.workers.dev'
const RESTA = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const OWNER_EMAIL = 'flashtap.staging.test@gmail.com'
const OWNER_PASSWORD = STAGING_TEST_PASSWORD
const KITCHEN_USER_ID = 'e65059f8-0727-4c9f-a268-4661eadb0325'
const KITCHEN_EMAIL = 'staging.kitchen.test@gmail.com'
const KITCHEN_PASSWORD = STAGING_TEST_PASSWORD

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function signIn(email: string, password: string) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session?.access_token) throw new Error(error?.message ?? 'sign-in failed')
  return data.session.access_token
}

async function getOwnerUserId(): Promise<string> {
  const { data, error } = await admin
    .from('restaurant_users')
    .select('user_id')
    .eq('restaurant_id', RESTA)
    .eq('role', 'owner')
    .maybeSingle()
  if (error) throw error
  if (!data?.user_id) throw new Error('No owner row on staging test restaurant')
  return String(data.user_id)
}

async function setKitchenUserRole(role: string) {
  const { error: ruError } = await admin
    .from('restaurant_users')
    .update({ role, updated_at: new Date().toISOString() })
    .eq('user_id', KITCHEN_USER_ID)
    .eq('restaurant_id', RESTA)
  if (ruError) throw ruError
  await admin.from('staff_members').update({ role }).eq('restaurant_id', RESTA).ilike('email', KITCHEN_EMAIL)
}

async function clearKitchenOverrides() {
  const { data: sm } = await admin
    .from('staff_members')
    .select('id')
    .eq('restaurant_id', RESTA)
    .ilike('email', KITCHEN_EMAIL)
    .maybeSingle()
  if (sm?.id) await admin.from('staff_permissions').delete().eq('staff_id', sm.id)
}

async function fetchApi(token: string, restaurantId: string) {
  const res = await fetch(
    `${STAGING}/api/analytics/orders-summary?restaurantId=${encodeURIComponent(restaurantId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const body = await res.json().catch(() => ({}))
  return {
    status: res.status,
    orderCount: Array.isArray(body.orders) ? body.orders.length : null,
    error: body.error as string | undefined,
  }
}

async function main() {
  const report: Record<string, unknown> = {}
  const ownerUserId = await getOwnerUserId()

  try {
    const ownerToken = await signIn(OWNER_EMAIL, OWNER_PASSWORD)
    report.owner = await fetchApi(ownerToken, RESTA)

    await admin
      .from('restaurant_users')
      .update({ role: 'manager', updated_at: new Date().toISOString() })
      .eq('user_id', ownerUserId)
      .eq('restaurant_id', RESTA)
    const managerToken = await signIn(OWNER_EMAIL, OWNER_PASSWORD)
    report.manager = await fetchApi(managerToken, RESTA)

    await admin
      .from('restaurant_users')
      .update({ role: 'owner', updated_at: new Date().toISOString() })
      .eq('user_id', ownerUserId)
      .eq('restaurant_id', RESTA)

    for (const role of ['waiter', 'kitchen', 'cashier', 'bar'] as const) {
      await clearKitchenOverrides()
      await setKitchenUserRole(role)
      const token = await signIn(KITCHEN_EMAIL, KITCHEN_PASSWORD)
      report[role] = await fetchApi(token, RESTA)
    }

    console.log(JSON.stringify(report, null, 2))

    const ok =
      (report.owner as { status: number }).status === 200 &&
      (report.manager as { status: number }).status === 200 &&
      ['waiter', 'kitchen', 'cashier', 'bar'].every(
        (r) => (report[r] as { status: number }).status === 403,
      )

    if (!ok) {
      console.error('FAIL: role matrix')
      process.exit(1)
    }
    console.log('ROLE_MATRIX_OK')
  } finally {
    await admin
      .from('restaurant_users')
      .update({ role: 'owner', updated_at: new Date().toISOString() })
      .eq('user_id', ownerUserId)
      .eq('restaurant_id', RESTA)
    await setKitchenUserRole('kitchen')
    await clearKitchenOverrides()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
