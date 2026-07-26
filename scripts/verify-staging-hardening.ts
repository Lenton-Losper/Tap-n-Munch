/**
 * Staging verification for tracker/security hardening push.
 * Uses service-role against staging Supabase + HTTP against staging Worker.
 *
 * Markers:
 *   VERIFY_STAGING_HARDENING_OK
 */
import { createClient } from '@supabase/supabase-js'

const STAGING_WORKER =
  process.env.STAGING_WORKER_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.STAGING_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

async function httpJson(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const res = await fetch(`${STAGING_WORKER}${path}`, {
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
  console.log('Worker:', STAGING_WORKER)
  console.log('Supabase URL set:', Boolean(url), 'service role set:', Boolean(key))

  const { formatPaymentLabel } = await import('../lib/receipts/formatPaymentLabel')
  assert(formatPaymentLabel('cash', '****1234') === 'CASH', 'cash label must ignore masked ref')
  assert(formatPaymentLabel('card', '****1234') === 'CARD ****1234', 'card label keeps masked ref')
  console.log('formatPaymentLabel OK')

  const create = await httpJson('POST', '/api/payments/create', {
    amount: 1,
    merchantNo: 'x',
    storeNo: 'y',
  })
  console.log('payments/create unauth', create.status, create.json)
  assert([401, 403].includes(create.status), 'payments/create must require auth')

  const reconcile = await httpJson('POST', '/api/payments/reconcile', {
    restaurantId: '00000000-0000-0000-0000-000000000000',
    orderIds: ['00000000-0000-0000-0000-000000000000'],
  })
  console.log('payments/reconcile unauth', reconcile.status, reconcile.json)
  assert([401, 403].includes(reconcile.status), 'payments/reconcile must require auth')

  const ready = await httpJson(
    'POST',
    '/api/orders/00000000-0000-0000-0000-000000000001/ready-for-terminal',
    { tableNumber: 1 },
  )
  console.log('ready-for-terminal no session', ready.status, ready.json)
  assert([401, 403, 404].includes(ready.status), 'ready-for-terminal must not succeed unauthenticated')

  const redis = await httpJson('GET', '/api/debug/redis')
  console.log('debug/redis', redis.status, redis.json)
  assert([401, 403, 404].includes(redis.status), 'debug/redis must be locked down')

  const cache = await httpJson('POST', '/api/cache/menu/invalidate', { restaurantId: 'x' })
  console.log('cache invalidate', cache.status, cache.json)
  assert([401, 403, 404].includes(cache.status), 'cache invalidate must be locked down')

  const whMissing = await httpJson('POST', '/api/webhooks/paycloud', {
    merchant_order_no: 'VERIFY-NO-SIGN',
    trans_status: 2,
    amount: 1,
  })
  console.log('webhook missing signature', whMissing.status, whMissing.json)
  assert(whMissing.status === 401, 'missing webhook signature must be 401')

  const whBad = await httpJson(
    'POST',
    '/api/webhooks/paycloud',
    {
      merchant_order_no: 'VERIFY-BAD-SIGN',
      trans_status: 2,
      amount: 1,
      sign: 'deadbeef',
    },
    { 'x-paycloud-sign': 'deadbeef' },
  )
  console.log('webhook bad signature', whBad.status, whBad.json)
  assert(whBad.status === 401, 'invalid webhook signature must be 401')

  if (!url || !key) {
    console.log('No service-role credentials — skipping DB probes')
    console.log('VERIFY_STAGING_HARDENING_OK')
    return
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })

  const { calculateOrderPricing, UnmatchedMenuItemError } = await import(
    '../lib/orders/calculate-order-pricing'
  )
  const { data: restaurant } = await supabase.from('restaurants').select('id').limit(1).maybeSingle()
  assert(restaurant?.id, 'need a restaurant row for pricing probe')

  let rejected = false
  try {
    await calculateOrderPricing(supabase as never, restaurant.id, [
      { menuItemId: '00000000-0000-0000-0000-000000000099', quantity: 1, subtotal: -50 },
    ])
  } catch (e) {
    rejected = e instanceof UnmatchedMenuItemError
    console.log('pricing reject:', (e as Error).message)
  }
  assert(rejected, 'expected UnmatchedMenuItemError for fake menuItemId')

  // Prefer a restaurant that actually has tables + menu for fuller probes.
  const { data: table } = await supabase
    .from('restaurant_tables')
    .select('table_number, restaurant_id, is_kiosk')
    .gt('table_number', 0)
    .limit(1)
    .maybeSingle()

  const pricingRestaurantId = String(table?.restaurant_id || restaurant.id)

  // Legitimate catalog pricing still works when a real available item exists.
  const { data: menuItem } = await supabase
    .from('menu_items')
    .select('id, status, base_price')
    .eq('restaurant_id', pricingRestaurantId)
    .in('status', ['available', 'active'])
    .limit(1)
    .maybeSingle()
  if (menuItem?.id) {
    const priced = await calculateOrderPricing(supabase as never, pricingRestaurantId, [
      { menuItemId: menuItem.id, quantity: 1 },
    ])
    console.log('catalog pricing total', priced.total, 'warnings', priced.warnings.length)
    assert(priced.items.every((i) => i.priceSource === 'catalog'), 'must be catalog-priced')
  } else {
    console.log('No available menu item for positive pricing probe — skipped')
  }

  if (table) {
    const sessA = `sess_verify_a_${Date.now()}`
    const sessB = `sess_verify_b_${Date.now()}`
    const { data: orderA, error: errA } = await supabase
      .from('orders')
      .insert({
        restaurant_id: table.restaurant_id,
        table_number: table.table_number,
        session_id: sessA,
        status: 'pending',
        payment_status: 'pending',
        channel: 'table',
        items: [],
        subtotal: 1,
        tax: 0,
        total: 1,
        is_closed: false,
      })
      .select('id')
      .single()
    assert(!errA && orderA?.id, `insert order A failed: ${errA?.message}`)
    const { data: orderB, error: errB } = await supabase
      .from('orders')
      .insert({
        restaurant_id: table.restaurant_id,
        table_number: table.table_number,
        session_id: sessB,
        status: 'pending',
        payment_status: 'pending',
        channel: 'table',
        items: [],
        subtotal: 2,
        tax: 0,
        total: 2,
        is_closed: false,
      })
      .select('id')
      .single()
    assert(!errB && orderB?.id, `insert order B failed: ${errB?.message}`)

    // Direct DB-scoped query (same predicate as guest active-table)
    const { data: scopedA } = await supabase
      .from('orders')
      .select('id, session_id')
      .eq('restaurant_id', table.restaurant_id)
      .eq('table_number', table.table_number)
      .eq('is_closed', false)
      .eq('session_id', sessA)
    const { data: scopedB } = await supabase
      .from('orders')
      .select('id, session_id')
      .eq('restaurant_id', table.restaurant_id)
      .eq('table_number', table.table_number)
      .eq('is_closed', false)
      .eq('session_id', sessB)

    console.log(
      'session scoping DB',
      (scopedA || []).map((o) => o.id),
      (scopedB || []).map((o) => o.id),
    )
    assert(
      (scopedA || []).some((o) => o.id === orderA.id) &&
        !(scopedA || []).some((o) => o.id === orderB.id),
      'session A must only see order A',
    )
    assert(
      (scopedB || []).some((o) => o.id === orderB.id) &&
        !(scopedB || []).some((o) => o.id === orderA.id),
      'session B must only see order B',
    )

    // Live guest API (deployed Worker) must enforce the same scope
    const guestA = await httpJson(
      'GET',
      `/api/guest/orders/active-table?restaurantId=${encodeURIComponent(String(table.restaurant_id))}&table_number=${table.table_number}&session_id=${encodeURIComponent(sessA)}`,
    )
    const guestNone = await httpJson(
      'GET',
      `/api/guest/orders/active-table?restaurantId=${encodeURIComponent(String(table.restaurant_id))}&table_number=${table.table_number}`,
    )
    console.log('guest active-table A', guestA.status, guestA.json)
    console.log('guest active-table no session', guestNone.status, guestNone.json)
    assert(guestA.status === 200, 'guest active-table should 200')
    const guestOrders = (guestA.json as { orders?: Array<{ id: string }> })?.orders || []
    assert(
      guestOrders.some((o) => o.id === orderA.id) && !guestOrders.some((o) => o.id === orderB.id),
      'live guest API must session-scope',
    )
    const noneOrders = (guestNone.json as { orders?: unknown[] })?.orders || []
    assert(noneOrders.length === 0, 'live guest API without session must return empty')

    await supabase.from('orders').delete().in('id', [orderA.id, orderB.id])
  } else {
    console.log('No table found for session probe — skipped')
  }

  // Kiosk channel without is_kiosk table should 403 via Worker
  const kioskForge = await httpJson('POST', '/api/orders', {
    restaurantId: pricingRestaurantId,
    tableNumber: Number(table?.table_number || 1),
    channel: 'kiosk',
    session_id: `sess_kiosk_forge_${Date.now()}`,
    items: [{ menuItemId: '00000000-0000-0000-0000-000000000099', quantity: 1, subtotal: 1 }],
    paymentMethod: 'cash',
  })
  console.log('forged kiosk channel', kioskForge.status, kioskForge.json)
  assert([400, 403].includes(kioskForge.status), 'forged kiosk must be rejected')

  console.log('VERIFY_STAGING_HARDENING_OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
