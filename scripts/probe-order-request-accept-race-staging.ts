/**
 * Staging probe: concurrent Accept on the same order_request.
 * Expects exactly one 200 winner, one 409 loser, one orders row, and at most one
 * Finatic/hosted checkout write on that order.
 *
 * Marker: PROBE_ORDER_REQUEST_ACCEPT_RACE_OK
 *
 * Trigger: commit message contains [probe-order-request-accept-race]
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const WORKER =
  process.env.STAGING_WORKER_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.STAGING_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''
const anonKey =
  process.env.SUPABASE_ANON_KEY ||
  process.env.STAGING_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  ''

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

function log(label: string, value: unknown) {
  console.log(`== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main() {
  assert(url && serviceKey && anonKey, 'Need staging URL + service role + anon key')

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const tag = `accept-race-${Date.now()}`
  const email = `${tag}@flashtap-test.invalid`
  const password = `Set${randomUUID().slice(0, 8)}!1a`

  const { data: table } = await admin
    .from('restaurant_tables')
    .select('id, table_number, restaurant_id')
    .eq('active', true)
    .eq('is_view_only', false)
    .gt('table_number', 0)
    .limit(1)
    .maybeSingle()
  assert(table?.id, 'need an active table on staging')

  const { data: restaurant } = await admin
    .from('restaurants')
    .select('id, firebase_id')
    .eq('id', table.restaurant_id)
    .single()
  assert(restaurant?.id, 'restaurant missing')

  const { data: authUser, error: createUserErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  assert(!createUserErr && authUser.user?.id, `createUser failed: ${createUserErr?.message}`)
  const userId = authUser.user.id

  let requestId: string | null = null
  let orderIds: string[] = []

  try {
    const { error: userRowErr } = await admin.from('users').upsert({
      id: userId,
      email,
      full_name: 'Accept Race Probe',
    })
    assert(!userRowErr, `users upsert failed: ${userRowErr?.message}`)

    // Prefer existing owner role permissions; only insert if missing (FK for restaurant_users).
    const { data: existingOwnerRole } = await admin
      .from('restaurant_roles')
      .select('role_slug')
      .eq('restaurant_id', restaurant.id)
      .eq('role_slug', 'owner')
      .maybeSingle()
    if (!existingOwnerRole) {
      const { error: roleErr } = await admin.from('restaurant_roles').insert({
        restaurant_id: restaurant.id,
        role_slug: 'owner',
        display_name: 'Owner',
        permissions: ['orders:read', 'orders:update'],
        is_system: true,
      })
      assert(!roleErr, `restaurant_roles insert failed: ${roleErr?.message}`)
    }

    const { error: membershipErr } = await admin.from('restaurant_users').insert({
      restaurant_id: restaurant.id,
      user_id: userId,
      role: 'owner',
      invite_accepted: true,
    })
    assert(!membershipErr, `restaurant_users insert failed: ${membershipErr?.message}`)

    const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
      email,
      password,
    })
    assert(!signInErr && signIn.session?.access_token, `sign-in failed: ${signInErr?.message}`)
    const token = signIn.session.access_token

    const { data: seeded, error: seedErr } = await admin
      .from('order_requests')
      .insert({
        restaurant_id: restaurant.id,
        firebase_restaurant_id: restaurant.firebase_id || restaurant.id,
        channel: 'table',
        table_number: table.table_number,
        table_id: table.id,
        session_id: `sess_${tag}`,
        items: [],
        subtotal: 12,
        tax: 0,
        total: 12,
        payment_method: 'card',
        payment_channel: 'hosted',
        status: 'waiting_review',
        // Intentionally null — accept route must still collapse via order-request-accept:{id}
        idempotency_key: null,
      })
      .select('id')
      .single()
    assert(!seedErr && seeded?.id, `seed order_request failed: ${seedErr?.message}`)
    requestId = seeded.id
    log('seeded order_request', { requestId, restaurantId: restaurant.id })

    const acceptUrl = `${WORKER}/api/order-requests/${encodeURIComponent(requestId)}/accept`
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    // Near-simultaneous Accepts
    const [resA, resB] = await Promise.all([
      fetch(acceptUrl, { method: 'POST', headers, body: '{}' }),
      fetch(acceptUrl, { method: 'POST', headers, body: '{}' }),
    ])
    const [bodyA, bodyB] = await Promise.all([
      resA.json().catch(() => ({})),
      resB.json().catch(() => ({})),
    ])

    log('accept A', { status: resA.status, body: bodyA })
    log('accept B', { status: resB.status, body: bodyB })

    const statuses = [resA.status, resB.status].sort((a, b) => a - b)
    assert(
      statuses[0] === 200 && statuses[1] === 409,
      `expected one 200 and one 409, got ${resA.status}/${resB.status}`,
    )

    const winnerBody = resA.status === 200 ? bodyA : bodyB
    const loserBody = resA.status === 409 ? bodyA : bodyB
    assert(winnerBody.success === true, 'winner must return success:true')
    assert(winnerBody.orderId, 'winner must return orderId')
    assert(
      String(loserBody.error || '').toLowerCase().includes('already handled') ||
        String(loserBody.error || '').length > 0,
      'loser must return a clean error body',
    )
    assert(!loserBody.orderId, 'loser 409 must not return a new orderId payload')

    const acceptKey = `order-request-accept:${requestId}`
    const { data: orders, error: ordersErr } = await admin
      .from('orders')
      .select('id, idempotency_key, payment_checkout_url, paycloud_merchant_order_no')
      .or(`idempotency_key.eq.${acceptKey},id.eq.${winnerBody.orderId}`)
    assert(!ordersErr, `orders query failed: ${ordersErr?.message}`)
    orderIds = (orders || []).map((o) => o.id)

    const uniqueOrderIds = [...new Set(orderIds)]
    log('orders created', orders)
    assert(uniqueOrderIds.length === 1, `expected exactly 1 order, got ${uniqueOrderIds.length}`)
    assert(
      uniqueOrderIds[0] === String(winnerBody.orderId),
      'sole order must match winner orderId',
    )

    const { data: reqRow } = await admin
      .from('order_requests')
      .select('status, accepted_order_id')
      .eq('id', requestId)
      .single()
    log('order_request final', reqRow)
    assert(reqRow?.status === 'accepted', 'request must end accepted')
    assert(
      String(reqRow?.accepted_order_id) === String(winnerBody.orderId),
      'accepted_order_id must match winner',
    )

    const order = orders![0]
    const finaticWrites = [order.payment_checkout_url, order.paycloud_merchant_order_no].filter(
      (v) => v != null && String(v).trim() !== '',
    ).length
    // Hosted path is best-effort; if Finatic is up we get both fields from the single winner.
    // Either way the loser must not have produced a second order/session row.
    log('finatic fields on sole order', {
      payment_checkout_url: order.payment_checkout_url,
      paycloud_merchant_order_no: order.paycloud_merchant_order_no,
      finaticWrites,
      winnerCheckoutUrl: winnerBody.checkoutUrl ?? null,
      loserHadCheckoutUrl: Boolean(loserBody.checkoutUrl),
    })
    assert(!loserBody.checkoutUrl, 'loser must not return checkoutUrl (no second Finatic session)')

    console.log('PROBE_ORDER_REQUEST_ACCEPT_RACE_OK')
  } finally {
    if (orderIds.length) {
      await admin.from('orders').delete().in('id', [...new Set(orderIds)])
    }
    if (requestId) {
      await admin.from('order_requests').delete().eq('id', requestId)
    }
    await admin.from('restaurant_users').delete().eq('user_id', userId)
    await admin.from('users').delete().eq('id', userId)
    await admin.auth.admin.deleteUser(userId)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
