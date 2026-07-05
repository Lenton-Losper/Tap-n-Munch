/**
 * Staging security verification for payment terminal + menu subcategory routes.
 *   npx tsx scripts/verify-payment-routes-security-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { PERMISSIONS } from '../lib/permissions'
import { getRolePermissionsFromConfig } from '../lib/permissions/role-permissions-config'

config({ path: '.env.test', override: true })

const APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const tag = `pay-route-sec-${Date.now()}`
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
let managerAId: string | null = null
let categoryAId: string | null = null
let orderAId: string | null = null
let subcategoryId: string | null = null

const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`
const managerAEmail = `${tag}.manager-a@flashtap-test.invalid`

const fakeOrderId = '00000000-0000-4000-8000-000000000099'
const fakeRestaurantId = '00000000-0000-4000-8000-000000000098'
const fakeCategoryId = '00000000-0000-4000-8000-000000000097'

async function signIn(email: string) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session.access_token
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${APP}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

async function seedRestaurantRoles(restaurantId: string) {
  const ownerPerms = getRolePermissionsFromConfig('owner')
  const managerPerms = getRolePermissionsFromConfig('manager')
  if (!ownerPerms || !managerPerms) {
    throw new Error('owner/manager permissions missing from role-permissions.config.json')
  }
  const { error } = await dbAdmin.from('restaurant_roles').upsert(
    [
      {
        restaurant_id: restaurantId,
        role_slug: 'owner',
        display_name: 'Owner',
        permissions: [...ownerPerms],
        is_system: true,
      },
      {
        restaurant_id: restaurantId,
        role_slug: 'manager',
        display_name: 'Manager',
        permissions: [...managerPerms],
        is_system: false,
      },
    ],
    { onConflict: 'restaurant_id,role_slug' },
  )
  if (error) throw error
}

async function seed() {
  const { data: restA, error: restAErr } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} Restaurant A`, subscription_status: 'active' })
    .select('id')
    .single()
  if (restAErr) throw restAErr
  restAId = restA.id

  const { data: restB, error: restBErr } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} Restaurant B`, subscription_status: 'active' })
    .select('id')
    .single()
  if (restBErr) throw restBErr
  restBId = restB.id

  await seedRestaurantRoles(restAId!)
  await seedRestaurantRoles(restBId!)

  for (const [email, restId, role] of [
    [ownerAEmail, restAId, 'owner'],
    [ownerBEmail, restBId, 'owner'],
    [managerAEmail, restAId, 'manager'],
  ] as const) {
    const { data: authUser, error: authErr } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (authErr || !authUser.user) throw authErr || new Error('createUser failed')

    const userId = authUser.user.id
    if (email === ownerAEmail) ownerAId = userId
    if (email === ownerBEmail) ownerBId = userId
    if (email === managerAEmail) managerAId = userId

    await dbAdmin.from('users').insert({
      id: userId,
      email,
      restaurant_id: restId,
      name: email.split('@')[0],
    })

    const { error: ruError } = await dbAdmin.from('restaurant_users').insert({
      user_id: userId,
      restaurant_id: restId,
      role,
      invite_accepted: true,
    })
    if (ruError) throw ruError
  }

  const { data: category, error: catErr } = await dbAdmin
    .from('menu_categories')
    .insert({
      restaurant_id: restAId,
      name: `${tag} Category`,
      display_order: 1,
      active: true,
      route_to: 'kitchen',
    })
    .select('id')
    .single()
  if (catErr) throw catErr
  categoryAId = category.id

  const { data: order, error: orderErr } = await dbAdmin
    .from('orders')
    .insert({
      restaurant_id: restAId,
      table_number: 99,
      status: 'pending',
      payment_status: 'pending',
      payment_method: 'card',
      payment_channel: 'terminal',
      total: 25.5,
      subtotal: 25.5,
      items: [{ name: 'Probe Item', quantity: 1, route_to: 'kitchen' }],
      session_id: `probe-${tag}`,
      placed_at: new Date().toISOString(),
    })
    .select('id, total')
    .single()
  if (orderErr) throw orderErr
  orderAId = order.id
}

async function cleanup() {
  if (subcategoryId) {
    await dbAdmin.from('menu_subcategories').delete().eq('id', subcategoryId)
  }
  if (orderAId) await dbAdmin.from('orders').delete().eq('id', orderAId)
  if (categoryAId) await dbAdmin.from('menu_categories').delete().eq('id', categoryAId)
  for (const id of [ownerAId, ownerBId, managerAId]) {
    if (id) await authAdmin.auth.admin.deleteUser(id)
  }
  if (restAId) {
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', restAId)
    await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', restAId)
    await dbAdmin.from('restaurants').delete().eq('id', restAId)
  }
  if (restBId) {
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', restBId)
    await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', restBId)
    await dbAdmin.from('restaurants').delete().eq('id', restBId)
  }
}

async function main() {
  console.log(`[verify-payment-routes-security] APP=${APP}`)
  await seed()

  try {
    const pushOpen = await postJson('/api/payments/push-to-terminal', {
      orderId: fakeOrderId,
      restaurantId: fakeRestaurantId,
      amount: 99999,
    })
    assert(pushOpen.status === 401, `push-to-terminal unauth: expected 401, got ${pushOpen.status}`)

    const cancelOpen = await postJson('/api/payments/cancel-terminal', {
      orderId: fakeOrderId,
      restaurantId: fakeRestaurantId,
    })
    assert(cancelOpen.status === 401, `cancel-terminal unauth: expected 401, got ${cancelOpen.status}`)

    const subOpen = await postJson('/api/admin/menu/subcategories', {
      restaurantId: fakeRestaurantId,
      categoryId: fakeCategoryId,
      name: 'PROBE_UNAUTH',
    })
    assert(subOpen.status === 401, `subcategories unauth: expected 401, got ${subOpen.status}`)

    console.log('OK unauthenticated calls rejected (401)')

    const managerToken = await signIn(managerAEmail)
    const ownerBToken = await signIn(ownerBEmail)

    const crossPush = await postJson(
      '/api/payments/push-to-terminal',
      { orderId: orderAId!, amount: 99999, restaurantId: restBId },
      ownerBToken,
    )
    assert(
      crossPush.status === 403,
      `cross-tenant push: expected 403, got ${crossPush.status} ${JSON.stringify(crossPush.json)}`,
    )

    const crossCancel = await postJson(
      '/api/payments/cancel-terminal',
      { orderId: orderAId!, restaurantId: restBId },
      ownerBToken,
    )
    assert(
      crossCancel.status === 403,
      `cross-tenant cancel: expected 403, got ${crossCancel.status}`,
    )

    const crossSub = await postJson(
      '/api/admin/menu/subcategories',
      {
        restaurantId: restBId,
        categoryId: categoryAId,
        name: 'PROBE_CROSS',
      },
      ownerBToken,
    )
    assert(
      crossSub.status === 403,
      `cross-tenant subcategory: expected 403, got ${crossSub.status} ${JSON.stringify(crossSub.json)}`,
    )

    console.log('OK cross-tenant blocked (403)')

    const amountProbe = await postJson(
      '/api/payments/push-to-terminal',
      {
        orderId: orderAId!,
        amount: 99999,
        restaurantId: restAId,
        tableNumber: 99,
        orderNumber: 1,
      },
      managerToken,
    )
    assert(
      amountProbe.status !== 401 && amountProbe.status !== 403,
      `amount probe: auth should pass (not 401/403), got ${amountProbe.status}`,
    )
    const { data: orderAfterAmount } = await dbAdmin
      .from('orders')
      .select('total, payment_status')
      .eq('id', orderAId!)
      .single()
    assert(Number(orderAfterAmount?.total) === 25.5, 'order total unchanged in DB')
    console.log(
      `OK amount override probe: auth passed (${amountProbe.status}); order total still 25.5`,
    )

    const legitSub = await postJson(
      '/api/admin/menu/subcategories',
      {
        restaurantId: restAId,
        categoryId: categoryAId,
        name: `${tag} Sub`,
      },
      managerToken,
    )
    assert(legitSub.status === 200, `legit subcategory: expected 200, got ${legitSub.status}`)
    subcategoryId = String((legitSub.json.data as { id?: string })?.id || '')
    assert(Boolean(subcategoryId), 'subcategory id missing')
    console.log('OK legitimate subcategory create (200)')

    const legitPush = await postJson(
      '/api/payments/push-to-terminal',
      { orderId: orderAId!, tableNumber: 99, orderNumber: 1 },
      managerToken,
    )
    assert(
      legitPush.status !== 401 && legitPush.status !== 403,
      `legit push: expected past auth, got ${legitPush.status}`,
    )
    console.log(`OK legitimate push-to-terminal past auth (${legitPush.status})`)

    await dbAdmin
      .from('orders')
      .update({
        payment_status: 'terminal_pending',
        payment_method: 'card_terminal',
      })
      .eq('id', orderAId!)

    const legitCancel = await postJson(
      '/api/payments/cancel-terminal',
      { orderId: orderAId! },
      managerToken,
    )
    assert(
      legitCancel.status !== 401 && legitCancel.status !== 403,
      `legit cancel: expected past auth, got ${legitCancel.status}`,
    )
    console.log(`OK legitimate cancel-terminal past auth (${legitCancel.status})`)

    console.log('\nPAYMENT_ROUTES_SECURITY_STAGING_OK')
    console.log(`Permission used: ${PERMISSIONS.PAYMENTS_PROCESS} (terminal financial ops)`)
  } finally {
    await cleanup()
    console.log('Cleanup complete')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
