/**
 * Staging HTTP probe: webhook signature-failure → Finatic order.query fallback.
 *
 * Simulates invalid-signature webhooks for pending orders and uses staging-only
 * `__stagingFinaticStub` so we exercise paid / not_paid / unreachable without
 * live Finatic charges.
 *
 * Marker: PROBE_WEBHOOK_SIG_FALLBACK_OK
 * Trigger: commit message contains [probe-webhook-sig-fallback]
 *
 *   npx tsx scripts/probe-webhook-sig-fallback-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const WORKER =
  process.env.STAGING_WORKER_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.STAGING_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

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
  return { status: res.status, json, text, headers: Object.fromEntries(res.headers.entries()) }
}

async function main() {
  assert(url.includes(STAGING_REF) && serviceKey, 'Need staging URL + service role')
  log('worker', WORKER)
  log('supabase', url)

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const tag = `wh-sig-fallback-${Date.now()}`
  const orderIds: string[] = []

  const { data: restaurantWithCreds } = await admin
    .from('restaurants')
    .select('id')
    .not('finatic_merchant_no', 'is', null)
    .not('finatic_store_no', 'is', null)
    .limit(1)
    .maybeSingle()
  const { data: restaurantAny } = restaurantWithCreds?.id
    ? { data: restaurantWithCreds }
    : await admin.from('restaurants').select('id').limit(1).maybeSingle()
  assert(restaurantAny?.id, 'need a restaurant on staging')
  const restaurantId = String(restaurantAny.id)

  const insertOrder = async (suffix: string, merchantOrderNo: string) => {
    const { data, error } = await admin
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        table_number: 0,
        channel: 'pos',
        status: 'pending',
        payment_status: 'pending',
        payment_method: 'card',
        subtotal: 11.5,
        tax: 0,
        total: 11.5,
        items: [{ name: `${tag}-${suffix}`, quantity: 1, price: 11.5 }],
        placed_at: new Date().toISOString(),
        paycloud_merchant_order_no: merchantOrderNo,
      })
      .select('id, payment_status, paid_at, paycloud_merchant_order_no')
      .single()
    assert(!error && data?.id, `order insert ${suffix}: ${error?.message}`)
    orderIds.push(String(data.id))
    return data
  }

  const readOrder = async (id: string) => {
    const { data, error } = await admin
      .from('orders')
      .select('id, status, payment_status, paid_at, payment_reference, paycloud_merchant_order_no')
      .eq('id', id)
      .single()
    assert(!error && data, `read order ${id}: ${error?.message}`)
    return data
  }

  const readFallbackAudit = async (orderId: string) => {
    const { data, error } = await admin
      .from('audit_logs')
      .select('action, metadata, created_at')
      .eq('entity_id', orderId)
      .eq('action', 'payment.completed')
      .order('created_at', { ascending: false })
      .limit(3)
    assert(!error, `audit read failed: ${error?.message}`)
    return data ?? []
  }

  try {
    // ----- A: invalid signature + Finatic confirms paid → mark paid, 200 success -----
    const moA = `FTWHPAID${Date.now()}`.slice(0, 32)
    const orderA = await insertOrder('paid', moA)
    const resA = await httpJson(
      'POST',
      '/api/webhooks/paycloud',
      {
        merchant_order_no: moA,
        // Untrusted payload deliberately claims NOT paid — fallback must ignore this.
        trans_status: 1,
        paid_amount: 11.5,
        amount: 11.5,
        sign: 'deadbeef-invalid-signature',
        __stagingFinaticStub: 'paid',
      },
      { 'x-paycloud-sign': 'deadbeef-invalid-signature' },
    )
    log('SCENARIO_A_HTTP_PAID_FALLBACK', resA)
    const rowA = await readOrder(String(orderA.id))
    log('SCENARIO_A_DB', rowA)
    const auditA = await readFallbackAudit(String(orderA.id))
    log('SCENARIO_A_AUDIT', auditA)
    assert(resA.status === 200, `A: expected HTTP 200, got ${resA.status}`)
    assert(resA.text.trim() === 'success', `A: expected plain success, got ${JSON.stringify(resA.text)}`)
    assert(rowA.payment_status === 'paid', `A: expected paid, got ${rowA.payment_status}`)
    assert(rowA.paid_at, 'A: expected paid_at set')
    assert(
      auditA.some(
        (a) =>
          (a.metadata as any)?.path === 'fallback_verified_paid' &&
          (a.metadata as any)?.source === 'paycloud_webhook_fallback_finatic_verified',
      ),
      'A: expected fallback_verified_paid audit',
    )
    console.log('SCENARIO_A_FALLBACK_VERIFIED_PAID_OK')

    // ----- B: invalid signature + Finatic confirms not paid → do not mark paid, still 200 -----
    const moB = `FTWHNP${Date.now()}`.slice(0, 32)
    const orderB = await insertOrder('not-paid', moB)
    const resB = await httpJson(
      'POST',
      '/api/webhooks/paycloud',
      {
        merchant_order_no: moB,
        // Untrusted payload deliberately claims PAID — fallback must ignore this.
        trans_status: 2,
        paid_amount: 11.5,
        amount: 11.5,
        sign: 'deadbeef-invalid-signature',
        __stagingFinaticStub: 'not_paid',
      },
      { 'x-paycloud-sign': 'deadbeef-invalid-signature' },
    )
    log('SCENARIO_B_HTTP_NOT_PAID_FALLBACK', resB)
    const rowB = await readOrder(String(orderB.id))
    log('SCENARIO_B_DB', rowB)
    assert(resB.status === 200, `B: expected HTTP 200, got ${resB.status}`)
    assert(resB.text.trim() === 'success', `B: expected plain success, got ${JSON.stringify(resB.text)}`)
    assert(rowB.payment_status === 'pending', `B: must stay pending, got ${rowB.payment_status}`)
    assert(!rowB.paid_at, 'B: paid_at must remain null')
    console.log('SCENARIO_B_FALLBACK_VERIFIED_NOT_PAID_OK')

    // ----- C: invalid signature + Finatic unreachable → 503, leave pending -----
    const moC = `FTWHUN${Date.now()}`.slice(0, 32)
    const orderC = await insertOrder('unreachable', moC)
    const resC = await httpJson(
      'POST',
      '/api/webhooks/paycloud',
      {
        merchant_order_no: moC,
        trans_status: 2,
        paid_amount: 11.5,
        amount: 11.5,
        sign: 'deadbeef-invalid-signature',
        __stagingFinaticStub: 'unreachable',
      },
      { 'x-paycloud-sign': 'deadbeef-invalid-signature' },
    )
    log('SCENARIO_C_HTTP_UNREACHABLE_FALLBACK', resC)
    const rowC = await readOrder(String(orderC.id))
    log('SCENARIO_C_DB', rowC)
    assert(resC.status === 503, `C: expected HTTP 503, got ${resC.status}`)
    assert(
      typeof resC.json === 'object' &&
        resC.json &&
        String((resC.json as any).error || '').includes('Finatic fallback query unavailable'),
      `C: unexpected body ${JSON.stringify(resC.json)}`,
    )
    assert(rowC.payment_status === 'pending', `C: must stay pending, got ${rowC.payment_status}`)
    assert(!rowC.paid_at, 'C: paid_at must remain null')
    console.log('SCENARIO_C_FALLBACK_QUERY_FAILED_OK')

    console.log('PROBE_WEBHOOK_SIG_FALLBACK_OK')
  } finally {
    if (orderIds.length) {
      await admin.from('audit_logs').delete().in('entity_id', orderIds)
      await admin.from('orders').delete().in('id', orderIds)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
