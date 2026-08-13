/**
 * Staging probe: a customer edit and a staff "start preparing" fired at the same instant on the
 * same order, against the DEPLOYED worker.
 *
 * The ruling is STAFF WINS. What this asserts is not that the API returns tidy status codes but
 * that the DATABASE cannot end up in the state the ruling forbids: an order that is `preparing`
 * and also carries the customer's edited items. Whichever way the race falls, exactly one of
 * these is true afterwards:
 *
 *   staff won   -> status preparing, items UNCHANGED, edit lock cleared, customer got 409
 *   customer won-> items edited, status back to pending (total changed), staff got 409 or the
 *                  order moved to preparing only if the edit landed first AND the total held
 *
 * and never both-edited-and-preparing.
 *
 * Marker: PROBE_ORDER_EDIT_LOCK_RACE_OK
 * Run:    npx tsx scripts/probe-order-edit-lock-race-staging.ts
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

const PRICED_LINES = [
  {
    name: 'Probe Burger',
    displayName: 'Probe Burger',
    quantity: 2,
    unitPrice: 100,
    subtotal: 173.91,
    tax: 26.09,
    total: 200,
    taxRatePercentage: 15,
    taxInclusive: true,
    priceSource: 'catalog',
  },
  {
    name: 'Probe Coke',
    displayName: 'Probe Coke',
    quantity: 1,
    unitPrice: 25,
    subtotal: 21.74,
    tax: 3.26,
    total: 25,
    taxRatePercentage: 15,
    taxInclusive: true,
    priceSource: 'catalog',
  },
]

async function main() {
  assert(url && serviceKey && anonKey, 'Need staging URL + service role + anon key')

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const tag = `edit-race-${Date.now()}`
  const email = `${tag}@flashtap-test.invalid`
  const password = `Set${randomUUID().slice(0, 8)}!1a`
  const sessionId = `sess_${tag}`

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
    const { error: userRowErr } = await admin
      .from('users')
      .upsert({ id: userId, email, full_name: 'Edit Race Probe' })
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
    const staffToken = signIn.session.access_token

    // An ACCEPTED order — editable, and one staff click away from preparing. Priced lines are
    // seeded directly so the probe does not depend on staging's menu having a chargeable item.
    const { data: seeded, error: seedErr } = await admin
      .from('orders')
      .insert({
        restaurant_id: restaurant.id,
        firebase_restaurant_id: restaurant.firebase_id || restaurant.id,
        table_id: table.id,
        table_number: table.table_number,
        session_id: sessionId,
        status: 'accepted',
        payment_status: 'pending',
        payment_method: 'cash',
        channel: 'table',
        items: PRICED_LINES,
        subtotal: 195.65,
        tax: 29.35,
        total: 225,
        is_closed: false,
        order_number: 889001,
        placed_at: new Date().toISOString(),
      })
      .select('id, status, total')
      .single()
    assert(!seedErr && seeded?.id, `seed order failed: ${seedErr?.message}`)
    orderId = seeded.id
    log('seeded order', seeded)

    const editUrl = `${WORKER}/api/guest/orders/${encodeURIComponent(orderId)}/edit`
    const statusUrl = `${WORKER}/api/orders/${encodeURIComponent(orderId)}/status`
    const guestHeaders = { 'Content-Type': 'application/json' }
    const staffHeaders = {
      Authorization: `Bearer ${staffToken}`,
      'Content-Type': 'application/json',
    }

    // --- 1. The customer opens the editor and holds the lock.
    const lockRes = await fetch(editUrl, {
      method: 'POST',
      headers: guestHeaders,
      body: JSON.stringify({ restaurantId: restaurant.id, sessionId }),
    })
    const lockBody = await lockRes.json().catch(() => ({}))
    log('lock acquired', { status: lockRes.status, body: lockBody })
    assert(lockRes.status === 200 && lockBody.lockToken, 'customer could not acquire the edit lock')
    assert(lockBody.items?.length === 2, 'lock response should return the order lines')

    // The token must be a capability, not something a read hands out.
    const readRes = await fetch(
      `${WORKER}/api/guest/orders/${encodeURIComponent(orderId)}?restaurantId=${encodeURIComponent(restaurant.id)}&session_id=${encodeURIComponent(sessionId)}`,
    )
    const readBody = await readRes.json().catch(() => ({}))
    assert(
      !JSON.stringify(readBody).includes(String(lockBody.lockToken)),
      'the edit lock token leaked on a guest READ — anyone the table-number path admits could commit an edit',
    )
    assert(readBody.orders?.[0]?.edit_lock_held === true, 'the read should report a lock is held')
    console.log('token is not returned by a read: OK')

    // --- 2. Fire the customer's commit and the staff's "start preparing" together.
    const [resEdit, resStaff] = await Promise.all([
      fetch(editUrl, {
        method: 'PATCH',
        headers: guestHeaders,
        body: JSON.stringify({
          restaurantId: restaurant.id,
          sessionId,
          lockToken: lockBody.lockToken,
          // Drop the Coke: 225 -> 200.
          keep: [{ index: 0, quantity: 2 }],
        }),
      }),
      fetch(statusUrl, {
        method: 'PATCH',
        headers: staffHeaders,
        body: JSON.stringify({ status: 'preparing' }),
      }),
    ])
    const [bodyEdit, bodyStaff] = await Promise.all([
      resEdit.json().catch(() => ({})),
      resStaff.json().catch(() => ({})),
    ])

    log('customer edit', { status: resEdit.status, body: bodyEdit })
    log('staff preparing', { status: resStaff.status, body: bodyStaff })

    const { data: finalOrder, error: finalErr } = await admin
      .from('orders')
      .select(
        'id, status, total, items, edit_lock_token, requires_reacceptance, total_before_edit, customer_edit_count',
      )
      .eq('id', orderId)
      .single()
    assert(!finalErr && finalOrder, `reload failed: ${finalErr?.message}`)
    log('final order', {
      status: finalOrder.status,
      total: finalOrder.total,
      lineCount: Array.isArray(finalOrder.items) ? finalOrder.items.length : null,
      edit_lock_token: finalOrder.edit_lock_token,
      requires_reacceptance: finalOrder.requires_reacceptance,
      total_before_edit: finalOrder.total_before_edit,
      customer_edit_count: finalOrder.customer_edit_count,
    })

    const lineCount = Array.isArray(finalOrder.items) ? finalOrder.items.length : 0
    const itemsWereEdited = lineCount === 1
    const isPreparing = String(finalOrder.status) === 'preparing'

    // THE INVARIANT. Everything else is detail; this is the ruling.
    assert(
      !(itemsWereEdited && isPreparing),
      'FORBIDDEN STATE: the order is preparing AND carries the customer edit — an order being cooked changed underneath the kitchen',
    )

    // Exactly one side may report success.
    const editWon = resEdit.status === 200
    const staffWon = resStaff.status === 200
    assert(editWon !== staffWon, `exactly one side must win, got edit=${resEdit.status} staff=${resStaff.status}`)

    if (staffWon) {
      console.log('--- staff won (the expected direction) ---')
      assert(isPreparing, `staff won but status is ${finalOrder.status}`)
      assert(!itemsWereEdited, 'staff won but the items were edited anyway')
      assert(resEdit.status === 409, `losing edit must be 409, got ${resEdit.status}`)
      assert(
        String(bodyEdit.reason) === 'preparation_started' || String(bodyEdit.reason) === 'lock_lost',
        `losing edit must say why: got reason=${bodyEdit.reason}`,
      )
      assert(!bodyEdit.success, 'losing edit must not report success')
      assert(
        finalOrder.edit_lock_token === null,
        'staff transition must clear the edit lock — that is what makes the customer commit lose',
      )
      assert(
        Number(finalOrder.total) === 225,
        `staff won but the total moved to ${finalOrder.total}`,
      )
    } else {
      console.log('--- customer won (edit landed first; still a legal outcome) ---')
      assert(itemsWereEdited, 'edit reported success but the items are unchanged')
      assert(Number(finalOrder.total) === 200, `edit won but total is ${finalOrder.total}`)
      // A total change sends it back to review, so `preparing` must have been refused.
      assert(
        String(finalOrder.status) === 'pending',
        `a total-changing edit must return the order to pending, got ${finalOrder.status}`,
      )
      assert(finalOrder.requires_reacceptance === true, 'edit changed the total but did not ask for re-acceptance')
      assert(Number(finalOrder.total_before_edit) === 225, 'the before-total was not recorded for the dashboard')
      assert(resStaff.status === 409, `losing staff transition must be 409, got ${resStaff.status}`)
      assert(finalOrder.edit_lock_token === null, 'a committed edit must spend its lock')
    }

    // --- 3. Editing is closed PERMANENTLY once preparing. Re-check on whichever row we have.
    if (isPreparing) {
      const retry = await fetch(editUrl, {
        method: 'POST',
        headers: guestHeaders,
        body: JSON.stringify({ restaurantId: restaurant.id, sessionId }),
      })
      const retryBody = await retry.json().catch(() => ({}))
      log('re-open attempt while preparing', { status: retry.status, body: retryBody })
      assert(retry.status === 409, `re-opening a preparing order must be refused, got ${retry.status}`)
      assert(
        String(retryBody.reason) === 'preparation_started',
        `refusal must name preparation, got ${retryBody.reason}`,
      )
    }

    console.log('PROBE_ORDER_EDIT_LOCK_RACE_OK')
  } finally {
    // Leaves-first: nothing FKs to this order in the probe, but the order is deleted before the
    // staff user it was created under.
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
