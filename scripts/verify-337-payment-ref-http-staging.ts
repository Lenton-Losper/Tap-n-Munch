/**
 * #337 — THE PAYMENT-REFERENCE PATH, OVER HTTP, AGAINST DEPLOYED STAGING. Staging only.
 *
 * #337's fix added a door: a reference that looks like an order id is resolved by id instead of
 * being run through a filter over columns that never hold one. That door is proved elsewhere.
 *
 * THIS PROVES THE DOOR THAT WAS ALREADY THERE STILL OPENS. Adding a branch above an existing lookup
 * is exactly how the existing lookup quietly stops being reachable, and a real payment reference is
 * the case that matters on the money path -- it is what a gateway return actually carries.
 *
 * Over HTTP, not through the library, because the library was never the problem. The route is what
 * a customer's browser hits, and the route is where a validation guard, a query-parameter name or
 * an access check can differ from what the library does.
 *
 * NEGATIVE CONTROLS, because "found 1 row" alone cannot tell a working lookup from one that
 * returns everything:
 *   - a well-formed reference that belongs to nobody must return 0
 *   - a reference belonging to ANOTHER restaurant must return 0
 *   - a PostgREST filter injection must return 0, not the whole table
 *
 * Marker: VERIFY_337_HTTP_OK
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const BASE = process.env.FLASHTAP_BASE_URL || ''
if (!url.includes(STAGING_REF)) throw new Error('REFUSING: not staging - ' + url)
if (!BASE) throw new Error('FLASHTAP_BASE_URL is required — this test is over HTTP')

const db = createClient(url, key, { auth: { persistSession: false } })
let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures++
  console.log('  ' + (ok ? 'PASS' : '*** FAIL ***') + '  ' + label + (detail ? '  ' + detail : ''))
}

async function lookup(ref, restaurantId, tableNumber) {
  // `ref`, NOT `paymentRef`. The route reads `ref` or `tn` and nothing else, so `paymentRef=`
  // produces a 400 with an empty result — which reads exactly like a lookup that correctly found
  // nothing. #337's own reproduction steps carry this mistake, and so did the flow simulator.
  // It is the reason the positive control below exists.
  const qs = new URLSearchParams({
    ref: String(ref),
    restaurantId: String(restaurantId),
    table_number: String(tableNumber),
  })
  const res = await fetch(`${BASE}/api/guest/orders/by-payment-ref?${qs}`, {
    headers: { accept: 'application/json' },
  })
  const body = await res.json().catch(() => ({}))
  const rows = Array.isArray(body?.orders) ? body.orders : Array.isArray(body) ? body : []
  return { status: res.status, rows, body }
}

async function main() {
  const tag = 'v337-' + Date.now()
  console.log('staging ' + url + '\nbase    ' + BASE + '\nseed    ' + tag + '\n')

  let orgId = '', restA = '', restB = '', tableA = '', orderA = '', orderB = ''
  const PAY_REF = 'FT' + Date.now() + '0001'
  const OTHER_REF = 'FT' + Date.now() + '9999'

  const ins = async (t, row, what) => {
    const { data, error } = await db.from(t).insert(row).select('id').single()
    if (error) throw new Error(what + ': ' + error.message)
    return String(data.id)
  }

  try {
    const { data: u0 } = await db.from('users').select('id').limit(1).single()
    orgId = await ins('organizations', { name: tag, owner_user_id: String(u0.id) }, 'organizations')
    restA = await ins('restaurants', { name: tag + '-A', organization_id: orgId }, 'restaurants')
    restB = await ins('restaurants', { name: tag + '-B', organization_id: orgId }, 'restaurants')
    tableA = await ins('restaurant_tables',
      { restaurant_id: restA, table_number: 970, status: 'occupied', current_session_version: 1, active: true },
      'restaurant_tables')

    orderA = await ins('orders',
      { restaurant_id: restA, table_number: 970, status: 'new', payment_status: 'paid',
        payment_reference: PAY_REF, total: 42 },
      'orders')
    // Same shape at ANOTHER restaurant, to prove the scope holds.
    orderB = await ins('orders',
      { restaurant_id: restB, table_number: 970, status: 'new', payment_status: 'paid',
        payment_reference: OTHER_REF, total: 99 },
      'orders')

    console.log('THE PATH THAT MATTERS — a real gateway reference')
    const hit = await lookup(PAY_REF, restA, 970)
    check('HTTP 200', hit.status === 200, String(hit.status))
    check('the order is found by its payment_reference', hit.rows.length === 1,
      hit.rows.length + ' row(s)')
    check('and it is the right one', String(hit.rows[0]?.id) === orderA, String(hit.rows[0]?.id))

    console.log('\nNEGATIVE CONTROLS — the lookup must be able to say NO')
    const miss = await lookup('FT00000000000000000', restA, 970)
    check('a well-formed reference belonging to nobody returns 0', miss.rows.length === 0,
      miss.rows.length + ' row(s)')

    const crossTenant = await lookup(OTHER_REF, restA, 970)
    check('another restaurant\'s reference returns 0 at THIS restaurant', crossTenant.rows.length === 0,
      crossTenant.rows.length + ' row(s)')

    // #242/#254 class: a filter-syntax payload must not widen the query.
    const injection = await lookup('x,id.not.is.null', restA, 970)
    check('a PostgREST filter injection returns 0, not the table', injection.rows.length === 0,
      injection.rows.length + ' row(s)')

    console.log('\nPOSITIVE CONTROL FOR THE CONTROLS')
    // Without this, all three zeros above are equally explained by a dead endpoint.
    const again = await lookup(PAY_REF, restA, 970)
    check('the endpoint is still alive and still finds the real one', again.rows.length === 1,
      again.rows.length + ' row(s)')

    console.log(failures === 0 ? '\nVERIFY_337_HTTP_OK' : '\n*** ' + failures + ' CHECK(S) FAILED ***')
  } finally {
    for (const r of [restA, restB].filter(Boolean)) {
      await db.from('orders').delete().eq('restaurant_id', r)
      await db.from('restaurant_tables').delete().eq('restaurant_id', r)
      await db.from('restaurants').delete().eq('id', r)
    }
    if (orgId) await db.from('organizations').delete().eq('id', orgId)
    console.log('cleaned up')
  }
  if (failures > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
