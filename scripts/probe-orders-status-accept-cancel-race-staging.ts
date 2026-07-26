/**
 * Staging probe: concurrent Accept vs Cancel on the same orders row via
 * PATCH /api/orders/[orderId]/status (R-7 atomic status claim).
 *
 * Expects exactly one 200 winner, one 409 loser, and a final status that
 * matches the winner (accepted XOR cancelled) — never a mixed/corrupted state.
 *
 * Marker: PROBE_ORDERS_STATUS_ACCEPT_CANCEL_RACE_OK
 * Trigger: commit message contains [probe-orders-status-race]
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

  const tag = `status-race-${Date.now()}`
  const email = `${tag}@flashtap-test.invalid`
  const password = `Set${randomUUID().slice(0, 8)}!1a`

  const { data: table } = await admin
    .from('restaurant_tables')
    .select('id, table_number, restaurant_id')
    .eq('active', true)
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

  let orderId: string | null = null

  try {
    const { error: userRowErr } = await admin.from('users').upsert({
      id: userId,
      email,
      full_name: 'Status Race Probe',
    })
    assert(!userRowErr, `users upsert failed: ${userRowErr?.message}`)

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
        permissions: ['orders:read', 'orders:update', 'orders:delete'],
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
      .from('orders')
      .insert({
        restaurant_id: restaurant.id,
        firebase_restaurant_id: restaurant.firebase_id || restaurant.id,
        table_id: table.id,
        table_number: table.table_number,
        session_id: `sess_${tag}`,
        status: 'pending',
        payment_status: 'pending',
        payment_method: 'card',
        channel: 'table',
        items: [],
        subtotal: 15,
        tax: 0,
        total: 15,
        is_closed: false,
        order_number: 888001,
        placed_at: new Date().toISOString(),
      })
      .select('id, status')
      .single()
    assert(!seedErr && seeded?.id, `seed order failed: ${seedErr?.message}`)
    orderId = seeded.id
    log('seeded order', seeded)

    const statusUrl = `${WORKER}/api/orders/${encodeURIComponent(orderId)}/status`
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    // Near-simultaneous Accept vs Cancel (Decline on kitchen UI maps to cancelled)
    const [resAccept, resCancel] = await Promise.all([
      fetch(statusUrl, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: 'accepted' }),
      }),
      fetch(statusUrl, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: 'cancelled' }),
      }),
    ])
    const [bodyAccept, bodyCancel] = await Promise.all([
      resAccept.json().catch(() => ({})),
      resCancel.json().catch(() => ({})),
    ])

    log('accept', { status: resAccept.status, body: bodyAccept })
    log('cancel', { status: resCancel.status, body: bodyCancel })

    const statuses = [resAccept.status, resCancel.status].sort((a, b) => a - b)
    assert(
      statuses[0] === 200 && statuses[1] === 409,
      `expected one 200 and one 409, got accept=${resAccept.status} cancel=${resCancel.status}`,
    )

    const winnerIsAccept = resAccept.status === 200
    const winnerBody = winnerIsAccept ? bodyAccept : bodyCancel
    const loserBody = winnerIsAccept ? bodyCancel : bodyAccept
    const expectedFinal = winnerIsAccept ? 'accepted' : 'cancelled'

    assert(winnerBody.success === true, 'winner must return success:true')
    assert(
      String(winnerBody.order?.status) === expectedFinal,
      `winner body status must be ${expectedFinal}, got ${winnerBody.order?.status}`,
    )
    assert(
      String(loserBody.error || '').toLowerCase().includes('status changed') ||
        String(loserBody.error || '').length > 0,
      'loser must return a clean error body',
    )
    assert(!loserBody.success, 'loser must not report success')

    const { data: finalOrder, error: finalErr } = await admin
      .from('orders')
      .select('id, status, payment_status, is_closed, accepted_at, cancelled_at')
      .eq('id', orderId)
      .single()
    assert(!finalErr && finalOrder, `reload failed: ${finalErr?.message}`)
    log('final order', finalOrder)

    assert(
      String(finalOrder.status) === expectedFinal,
      `DB status must be ${expectedFinal}, got ${finalOrder.status}`,
    )

    if (expectedFinal === 'accepted') {
      assert(finalOrder.payment_status !== 'cancelled', 'accept winner must not leave payment cancelled')
      assert(finalOrder.is_closed !== true, 'accept winner must not set is_closed')
      assert(finalOrder.accepted_at, 'accept winner should set accepted_at')
      assert(!finalOrder.cancelled_at, 'accept winner must not set cancelled_at')
    } else {
      assert(finalOrder.payment_status === 'cancelled', 'cancel winner must set payment_status cancelled')
      assert(finalOrder.is_closed === true, 'cancel winner must set is_closed')
      assert(finalOrder.cancelled_at, 'cancel winner should set cancelled_at')
    }

    console.log('PROBE_ORDERS_STATUS_ACCEPT_CANCEL_RACE_OK')
  } finally {
    if (orderId) {
      await admin.from('orders').delete().eq('id', orderId)
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
