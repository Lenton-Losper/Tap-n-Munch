/**
 * Staging probe: Critical/High multi-tenant isolation fixes.
 *
 * Covers:
 *  1. RLS ENABLE+FORCE on tabs/restaurants/users/customer_sessions
 *  2. Anon PostgREST cannot read tab_pin / finatic_* / customer_sessions
 *  3. Tab join-by-UUID alone rejected (tableNumber + PIN rules)
 *  4. Guest by-session dump requires session_id
 *  5. Guest order fetch requires restaurantId binding
 *  6. Session token restaurant/tab mismatch → 403
 *
 * Marker: PROBE_TENANT_ISOLATION_OK
 * Trigger: commit message contains [probe-tenant-isolation]
 */
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

async function httpJson(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const res = await fetch(`${WORKER}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json, text }
}

async function main() {
  assert(url && serviceKey && anonKey, 'Need staging URL + service role + anon key')
  log('worker', WORKER)
  log('supabase', url)

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // --- 1. RLS status via helper RPC (migration must be applied) ---
  let rlsApplied = false
  const { data: rlsStatus, error: rlsErr } = await admin.rpc('list_tenant_isolation_rls_status')
  log('rls_status', { rlsErr: rlsErr?.message || null, rlsStatus })
  if (rlsErr) {
    console.log(
      'RLS_SQL_PASTE_REQUIRED: paste scripts/sql/apply-20260726200000-tenant-isolation-rls.sql in staging SQL editor (DDL secrets empty in CI).',
    )
  } else {
    const byName = Object.fromEntries((rlsStatus || []).map((r: any) => [r.table_name, r]))
    for (const table of ['tabs', 'restaurants', 'users', 'customer_sessions']) {
      assert(byName[table]?.rls_enabled === true, `${table} RLS not enabled`)
      assert(byName[table]?.rls_forced === true, `${table} RLS not FORCED`)
    }
    rlsApplied = true
    console.log('RLS ENABLE+FORCE OK')

    // --- 2. Anon column / table denials (only meaningful after RLS migration) ---
    const { data: restRow, error: restErr } = await anon
      .from('restaurants')
      .select('id, name, finatic_merchant_no')
      .limit(1)
      .maybeSingle()
    log('anon_restaurants_finatic', { restErr: restErr?.message || null, restRow })
    assert(restErr, 'anon must fail selecting finatic_merchant_no')

    const { data: publicRest, error: publicRestErr } = await anon
      .from('restaurants')
      .select('id, name')
      .limit(1)
      .maybeSingle()
    log('anon_restaurants_public', { publicRestErr: publicRestErr?.message || null, publicRest })
    assert(!publicRestErr, `anon public restaurant select failed: ${publicRestErr?.message}`)

    const { data: tabPinRow, error: tabPinErr } = await anon
      .from('tabs')
      .select('id, tab_pin')
      .limit(1)
      .maybeSingle()
    log('anon_tabs_pin', { tabPinErr: tabPinErr?.message || null, tabPinRow })
    assert(tabPinErr, 'anon must fail selecting tab_pin')

    const { data: sessions, error: sessErr } = await anon
      .from('customer_sessions')
      .select('token')
      .limit(1)
    log('anon_customer_sessions', { sessErr: sessErr?.message || null, count: sessions?.length })
    assert(sessErr || !sessions?.length, 'anon must not read customer_sessions')

    console.log('Anon PostgREST denial OK')
  }

  // Fixture restaurant/table
  const { data: table } = await admin
    .from('restaurant_tables')
    .select('id, table_number, restaurant_id')
    .eq('active', true)
    .eq('is_view_only', false)
    .gt('table_number', 0)
    .limit(1)
    .maybeSingle()
  assert(table?.id, 'need an active table on staging')

  const restaurantId = String(table.restaurant_id)
  const tableNumber = Number(table.table_number)
  const otherRestaurantId = '00000000-0000-4000-8000-000000000099'

  // Reuse the one-open-tab-per-table row when present (unique index).
  const pin = String(Math.floor(1000 + Math.random() * 9000))
  const { data: existingOpen } = await admin
    .from('tabs')
    .select('id, table_id, table_number, restaurant_id, session_version')
    .eq('restaurant_id', restaurantId)
    .eq('table_id', table.id)
    .eq('status', 'open')
    .maybeSingle()

  let tab = existingOpen
  let createdTab = false
  if (!tab?.id) {
    const { data: created, error: tabCreateErr } = await admin
      .from('tabs')
      .insert({
        restaurant_id: restaurantId,
        table_id: table.id,
        table_number: tableNumber,
        status: 'open',
        pin_required: true,
        tab_pin: pin,
        members: [],
        total: 0,
      })
      .select('id, table_id, table_number, restaurant_id, session_version')
      .single()
    assert(!tabCreateErr && created?.id, `tab create failed: ${tabCreateErr?.message}`)
    tab = created
    createdTab = true
  } else {
    const { error: pinErr } = await admin
      .from('tabs')
      .update({ pin_required: true, tab_pin: pin, members: [] })
      .eq('id', tab.id)
    assert(!pinErr, `tab pin update failed: ${pinErr?.message}`)
  }
  const tabId = String(tab.id)

  // Session token for this tab
  const sessionVersion = Number(tab.session_version || 1) || 1
  await admin.from('tabs').update({ session_version: sessionVersion }).eq('id', tabId)
  const tokenA = randomUUID()
  const { error: tokErr } = await admin.from('customer_sessions').insert({
    token: tokenA,
    tab_id: tabId,
    table_id: table.id,
    restaurant_id: restaurantId,
    session_version: sessionVersion,
    active: true,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  })
  assert(!tokErr, `session token insert failed: ${tokErr?.message}`)

  // Guest session ids + orders for dump / restaurant binding tests
  const guestSessA = `probe_iso_a_${Date.now()}`
  const guestSessB = `probe_iso_b_${Date.now()}`
  const { data: orderA, error: orderAErr } = await admin
    .from('orders')
    .insert({
      restaurant_id: restaurantId,
      table_number: tableNumber,
      tab_id: tabId,
      session_id: guestSessA,
      status: 'pending',
      payment_status: 'pending',
      items: [{ name: 'Probe A', quantity: 1, price: 1 }],
      subtotal: 1,
      tax: 0,
      total: 1,
      placed_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  assert(!orderAErr && orderA?.id, `orderA create failed: ${orderAErr?.message}`)

  const { data: orderB, error: orderBErr } = await admin
    .from('orders')
    .insert({
      restaurant_id: restaurantId,
      table_number: tableNumber,
      tab_id: tabId,
      session_id: guestSessB,
      status: 'pending',
      payment_status: 'pending',
      items: [{ name: 'Probe B', quantity: 1, price: 1 }],
      subtotal: 1,
      tax: 0,
      total: 1,
      placed_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  assert(!orderBErr && orderB?.id, `orderB create failed: ${orderBErr?.message}`)

  try {
    // --- 3. Tab join IDOR ---
    const joinUuidOnly = await httpJson('POST', `/api/tabs/${tabId}/join`, {
      restaurantId,
      sessionId: `join_${Date.now()}`,
      displayName: 'Probe',
    })
    log('join_uuid_only', joinUuidOnly)
    assert(joinUuidOnly.status === 400, 'join without tableNumber must 400')

    const joinWrongTable = await httpJson('POST', `/api/tabs/${tabId}/join`, {
      restaurantId,
      sessionId: `join_${Date.now()}`,
      displayName: 'Probe',
      tableNumber: tableNumber + 777,
    })
    log('join_wrong_table', joinWrongTable)
    assert(joinWrongTable.status === 403, 'join wrong table must 403')

    const joinNoPin = await httpJson('POST', `/api/tabs/${tabId}/join`, {
      restaurantId,
      sessionId: `join_${Date.now()}`,
      displayName: 'Probe',
      tableNumber,
    })
    log('join_no_pin', joinNoPin)
    assert(joinNoPin.status === 403, 'join without PIN when pin_required must 403')

    const joinOk = await httpJson('POST', `/api/tabs/${tabId}/join`, {
      restaurantId,
      sessionId: `join_ok_${Date.now()}`,
      displayName: 'Probe OK',
      tableNumber,
      pin,
    })
    log('join_ok', joinOk)
    assert(joinOk.status === 200, `legitimate PIN join must 200, got ${joinOk.status}`)
    assert((joinOk.json as any)?.sessionToken, 'join must return sessionToken')
    console.log('Tab join IDOR hardening OK')

    // --- 4. Guest by-session dump ---
    const dumpTabOnly = await httpJson(
      'GET',
      `/api/guest/orders/by-session?restaurantId=${encodeURIComponent(restaurantId)}&tabId=${encodeURIComponent(tabId)}`,
    )
    log('guest_by_session_tab_only', dumpTabOnly)
    assert(dumpTabOnly.status === 400, 'by-session without session_id must 400')

    const dumpSessA = await httpJson(
      'GET',
      `/api/guest/orders/by-session?restaurantId=${encodeURIComponent(restaurantId)}&session_id=${encodeURIComponent(guestSessA)}`,
    )
    log('guest_by_session_a', dumpSessA)
    assert(dumpSessA.status === 200, 'by-session with session_id must 200')
    const idsA = ((dumpSessA.json as any)?.orders || []).map((o: any) => String(o.id))
    assert(idsA.includes(String(orderA.id)), 'session A must see own order')
    assert(!idsA.includes(String(orderB.id)), 'session A must not see session B order')
    console.log('Guest by-session scoping OK')

    // --- 5. Guest order restaurant binding ---
    const wrongRest = await httpJson(
      'GET',
      `/api/guest/orders/${orderA.id}?restaurantId=${otherRestaurantId}&session_id=${encodeURIComponent(guestSessA)}`,
    )
    log('guest_order_wrong_restaurant', wrongRest)
    assert(wrongRest.status === 404, 'wrong restaurantId must 404')

    const noRest = await httpJson(
      'GET',
      `/api/guest/orders/${orderA.id}?session_id=${encodeURIComponent(guestSessA)}`,
    )
    log('guest_order_no_restaurant', noRest)
    assert(noRest.status === 400, 'missing restaurantId must 400')

    const okOrder = await httpJson(
      'GET',
      `/api/guest/orders/${orderA.id}?restaurantId=${encodeURIComponent(restaurantId)}&session_id=${encodeURIComponent(guestSessA)}`,
    )
    log('guest_order_ok', okOrder)
    assert(okOrder.status === 200, 'matching restaurant+session must 200')
    console.log('Guest restaurant binding OK')

    // --- 6. Session token claim binding ---
    const mismatchRest = await httpJson(
      'GET',
      `/api/orders?restaurantId=${otherRestaurantId}&tabId=${tabId}`,
      undefined,
      { 'x-session-token': tokenA },
    )
    log('orders_get_wrong_restaurant', mismatchRest)
    assert(mismatchRest.status === 403, 'token restaurant mismatch must 403')

    const mismatchTab = await httpJson(
      'GET',
      `/api/orders?restaurantId=${restaurantId}&tabId=${randomUUID()}`,
      undefined,
      { 'x-session-token': tokenA },
    )
    log('orders_get_wrong_tab', mismatchTab)
    assert(mismatchTab.status === 403, 'token tab mismatch must 403')

    const readyMismatch = await httpJson(
      'POST',
      `/api/tabs/${randomUUID()}/ready-to-pay`,
      { restaurantId, paymentPreference: 'card' },
      { 'x-session-token': tokenA },
    )
    log('ready_to_pay_wrong_tab', readyMismatch)
    assert(readyMismatch.status === 403, 'ready-to-pay tab mismatch must 403')

    console.log('Session token binding OK')
    console.log('PROBE_TENANT_ISOLATION_API_OK')
    if (!rlsApplied) {
      throw new Error(
        'API hardening OK, but RLS migration not applied. Paste scripts/sql/apply-20260726200000-tenant-isolation-rls.sql then re-run [probe-tenant-isolation].',
      )
    }
    console.log('PROBE_TENANT_ISOLATION_OK')
  } finally {
    await admin.from('orders').delete().in('id', [orderA.id, orderB.id])
    await admin.from('customer_sessions').delete().eq('token', tokenA)
    if (createdTab) {
      await admin.from('tabs').delete().eq('id', tabId)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
