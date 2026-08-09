/**
 * Staging probe: the payment_events insert contract for the settle-route SALE write (#156).
 *
 * The base migration 20260705300000 declares `initiated_by uuid NOT NULL REFERENCES users(id)`
 * and a singular `order_id`. BOTH have since been superseded (20260705340000 replaced order_id
 * with order_ids uuid[]; 20260705360000 dropped the NOT NULL on initiated_by, explicitly so
 * 'sale' rows -- which have no PIN-verified actor -- can be written). Reading the base migration
 * alone gives a contract that is wrong in two places, so this probes the DEPLOYED table instead
 * of trusting any single migration file.
 *
 * Every check is a CONTROL that can fail: each asserts a specific outcome, and the negative
 * cases assert that the database REJECTS the write. A probe that only tries valid inserts
 * would pass against a table with no constraints at all.
 *
 * Marker: PROBE_PAYMENT_EVENTS_CONTRACT_OK
 *
 *   npx tsx scripts/probe-payment-events-contract-staging.ts
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(here, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.STAGING_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

function ok(msg) {
  console.log(`  PASS  ${msg}`)
}

async function main() {
  assert(!url.includes(PRODUCTION_REF), 'Refusing to run against PRODUCTION')
  assert(url.includes(STAGING_REF), `Refusing to run: ${url} is not the staging project`)
  assert(serviceKey, 'Need staging service role key')
  console.log(`supabase: ${url}\n`)

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const created = []
  const createdOrderIds = []
  let restaurantId = ''

  try {
    const { data: restaurant } = await admin
      .from('restaurants')
      .select('id, name')
      .limit(1)
      .maybeSingle()
    assert(restaurant?.id, 'need a restaurant on staging')
    restaurantId = String(restaurant.id)
    console.log(`restaurant: ${restaurant.name} (${restaurantId})\n`)

    // A real order to point order_ids at -- the array holds uuids, and while there is no FK on
    // an array element, using a real order keeps the probe honest about the linkage shape.
    const { data: order, error: orderErr } = await admin
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        table_number: 0,
        channel: 'pos',
        status: 'completed',
        payment_status: 'paid',
        payment_method: 'card',
        total: 12.5,
      })
      .select('id')
      .single()
    assert(!orderErr, `could not create probe order: ${orderErr?.message}`)
    createdOrderIds.push(String(order.id))

    const base = (suffix) => ({
      restaurant_id: restaurantId,
      order_ids: [String(order.id)],
      event_type: 'sale',
      business_order_no: `PROBE-${Date.now()}-${suffix}`,
      origin_business_order_no: `PROBE-${Date.now()}-${suffix}`,
      transaction_id: `PROBE-TX-${suffix}`,
      terminal_id: 'probe-terminal',
      amount: 12.5,
      currency: 'NAD',
      idempotency_key: `PROBE-${Date.now()}-${suffix}`,
      reason_code: 'sale',
    })

    console.log('C1  initiated_by omitted entirely -> ACCEPTED (nullable, per 20260705360000)')
    const c1 = base('c1')
    const { data: r1, error: e1 } = await admin
      .from('payment_events')
      .insert(c1)
      .select('id, initiated_by, order_ids')
      .single()
    assert(!e1, `initiated_by is still NOT NULL on staging -- brief's contract holds: ${e1?.message}`)
    created.push(r1.id)
    assert(r1.initiated_by === null, `expected null initiated_by, got ${r1.initiated_by}`)
    ok('inserted with initiated_by NULL; the base migration NOT NULL is superseded')

    console.log('\nC2  explicit initiated_by: null -> ACCEPTED')
    const c2 = { ...base('c2'), initiated_by: null }
    const { data: r2, error: e2 } = await admin
      .from('payment_events')
      .insert(c2)
      .select('id')
      .single()
    assert(!e2, `explicit null initiated_by rejected: ${e2?.message}`)
    created.push(r2.id)
    ok('explicit null accepted -- matches what /payment-events/sale already writes')

    console.log('\nC3  singular order_id column -> MUST NOT EXIST (replaced by order_ids)')
    const { error: e3 } = await admin
      .from('payment_events')
      .insert({ ...base('c3'), order_id: String(order.id) })
    assert(e3, 'order_id was ACCEPTED -- the singular column still exists on staging')
    ok(`order_id rejected: ${e3.message.slice(0, 90)}`)

    console.log('\nC4  event_type "sale" is in the CHECK; a bogus one is REJECTED')
    const { error: e4 } = await admin
      .from('payment_events')
      .insert({ ...base('c4'), event_type: 'settle_card' })
    assert(e4, 'event_type CHECK did not reject "settle_card" -- the constraint is not enforced')
    ok(`"settle_card" rejected by CHECK: ${e4.message.slice(0, 70)}`)

    console.log('\nC5  UNIQUE (restaurant_id, idempotency_key) -> duplicate REJECTED with 23505')
    const dupKey = `PROBE-DUP-${Date.now()}`
    const { data: r5, error: e5 } = await admin
      .from('payment_events')
      .insert({ ...base('c5'), idempotency_key: dupKey })
      .select('id')
      .single()
    assert(!e5, `first insert of the dup pair failed: ${e5?.message}`)
    created.push(r5.id)
    const { error: e5b } = await admin
      .from('payment_events')
      .insert({ ...base('c5b'), idempotency_key: dupKey })
    assert(e5b, 'duplicate idempotency_key was ACCEPTED -- idempotency is NOT guaranteed')
    assert(
      e5b.code === '23505',
      `expected 23505 unique violation, got ${e5b.code}: ${e5b.message}`,
    )
    ok('duplicate rejected with 23505 -- a retried settle cannot double-record')

    console.log('\nC6  business_order_no NOT NULL -> null REJECTED')
    const { error: e6 } = await admin
      .from('payment_events')
      .insert({ ...base('c6'), business_order_no: null })
    assert(e6, 'null business_order_no was ACCEPTED -- cash could write a shapeless row')
    ok(`null business_order_no rejected: ${e6.message.slice(0, 70)}`)

    console.log('\nC7  reason_code NOT NULL -> null REJECTED')
    const { error: e7 } = await admin
      .from('payment_events')
      .insert({ ...base('c7'), reason_code: null })
    assert(e7, 'null reason_code was ACCEPTED')
    ok(`null reason_code rejected: ${e7.message.slice(0, 70)}`)

    console.log('\nC8  order_ids empty array -> REJECTED (payment_events_order_ids_not_empty)')
    const { error: e8 } = await admin
      .from('payment_events')
      .insert({ ...base('c8'), order_ids: [] })
    assert(e8, 'empty order_ids was ACCEPTED -- an unlinked ledger row is possible')
    ok(`empty order_ids rejected: ${e8.message.slice(0, 70)}`)

    console.log('\nC9  transaction_id nullable?')
    const { data: r9, error: e9 } = await admin
      .from('payment_events')
      .insert({ ...base('c9'), transaction_id: null })
      .select('id')
      .single()
    if (e9) {
      console.log(`  transaction_id is NOT NULL on staging: ${e9.message.slice(0, 70)}`)
    } else {
      created.push(r9.id)
      ok('transaction_id is nullable')
    }

    console.log('\nR1  existing sale rows on staging: how is initiated_by populated in practice?')
    const { data: sales } = await admin
      .from('payment_events')
      .select('id, initiated_by, terminal_id, business_order_no, transaction_id')
      .eq('event_type', 'sale')
      .not('id', 'in', `(${created.join(',')})`)
      .limit(20)
    const nullCount = (sales ?? []).filter((s) => s.initiated_by === null).length
    console.log(`  ${sales?.length ?? 0} pre-existing sale rows, ${nullCount} with initiated_by NULL`)
    const sameRef = (sales ?? []).filter(
      (s) => s.transaction_id && s.transaction_id === s.business_order_no,
    ).length
    console.log(`  ${sameRef} of them have transaction_id === business_order_no`)

    console.log('\nR2  audit_logs.restaurant_id nullable? (needed for a platform-wide cron row)')
    const { data: al, error: alErr } = await admin
      .from('audit_logs')
      .insert({
        restaurant_id: null,
        action: 'probe.contract_check',
        entity_type: 'probe',
        entity_id: null,
        metadata: { probe: true },
      })
      .select('id')
      .single()
    if (alErr) {
      console.log(`  audit_logs.restaurant_id is NOT NULL: ${alErr.message.slice(0, 80)}`)
    } else {
      ok('audit_logs.restaurant_id is nullable')
      await admin.from('audit_logs').delete().eq('id', al.id)
    }

    console.log('\nPROBE_PAYMENT_EVENTS_CONTRACT_OK')
  } finally {
    if (created.length) {
      const { error } = await admin.from('payment_events').delete().in('id', created)
      console.log(`\ncleanup: deleted ${created.length} payment_events rows${error ? ` (ERROR ${error.message})` : ''}`)
      const { data: left } = await admin.from('payment_events').select('id').in('id', created)
      console.log(`cleanup verified: ${left?.length ?? 0} of them remain`)
    }
    if (createdOrderIds.length) {
      const { error } = await admin.from('orders').delete().in('id', createdOrderIds)
      console.log(`cleanup: deleted ${createdOrderIds.length} probe orders${error ? ` (ERROR ${error.message})` : ''}`)
      const { data: left } = await admin.from('orders').select('id').in('id', createdOrderIds)
      console.log(`cleanup verified: ${left?.length ?? 0} of them remain`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
