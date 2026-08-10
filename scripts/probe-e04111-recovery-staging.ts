/**
 * Staging HTTP probe: PR1 recovery-path fix.
 *
 * Verifies over real HTTP against the staging Worker that:
 *   R1  an order auto-cancelled by the E04111 rule IS recovered when the payment turns out
 *       to be real, and its cancellation fields clear (no contradictory paid+cancelled row).
 *   R2  a payment we CANNOT apply is never ACKed 200 -- Finatic must keep retrying.
 *       Uses an 'auto_timeout' cancellation, which is deliberately outside the recovery
 *       scope, so the claim conflicts and the route must answer 503.
 *   R3  E04111 is classified structurally end-to-end (gatewayCode surfaces in the 503).
 *
 * Uses staging-only `__stagingFinaticStub`, so no live Finatic charges.
 *
 * Marker: PROBE_E04111_RECOVERY_OK
 *
 *   npx tsx scripts/probe-e04111-recovery-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
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

async function post(path: string, body: unknown) {
  const res = await fetch(`${WORKER}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-paycloud-sign': 'deadbeef-invalid-signature',
    },
    body: JSON.stringify(body),
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
  assert(url.includes(STAGING_REF), `Refusing to run: ${url} is not the staging project`)
  assert(serviceKey, 'Need staging service role key')
  log('worker', WORKER)
  log('supabase', url)

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const tag = `e04111-recovery-${Date.now()}`
  const orderIds: string[] = []

  const { data: restaurant } = await admin.from('restaurants').select('id').limit(1).maybeSingle()
  assert(restaurant?.id, 'need a restaurant on staging')
  const restaurantId = String(restaurant.id)

  const insertCancelledOrder = async (suffix: string, merchantOrderNo: string, reason: string) => {
    const cancelledAt = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const { data, error } = await admin
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        table_number: 0,
        channel: 'pos',
        status: 'cancelled',
        payment_status: 'cancelled',
        payment_method: 'card',
        subtotal: 42.5,
        tax: 0,
        total: 42.5,
        items: [{ name: `${tag}-${suffix}`, quantity: 1, price: 42.5 }],
        placed_at: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
        cancelled_at: cancelledAt,
        cancellation_reason: reason,
        paycloud_merchant_order_no: merchantOrderNo,
      })
      .select('id, payment_status, cancelled_at, cancellation_reason')
      .single()
    assert(!error && data?.id, `order insert ${suffix}: ${error?.message}`)
    orderIds.push(String(data.id))
    return data
  }

  const readOrder = async (id: string) => {
    const { data, error } = await admin
      .from('orders')
      .select(
        'id, status, payment_status, paid_at, cancelled_at, cancellation_reason, payment_reference, paycloud_merchant_order_no',
      )
      .eq('id', id)
      .single()
    assert(!error && data, `read order ${id}: ${error?.message}`)
    return data
  }

  const readAudit = async (orderId: string, action: string) => {
    const { data, error } = await admin
      .from('audit_logs')
      .select('action, metadata, created_at')
      .eq('entity_id', orderId)
      .eq('action', action)
      .order('created_at', { ascending: false })
      .limit(3)
    assert(!error, `audit read failed: ${error?.message}`)
    return data ?? []
  }

  try {
    // ---- R1: auto-cancelled by the E04111 rule + payment turns out real → recovered ----
    const mo1 = `FTRECOV${Date.now()}`.slice(0, 32)
    const o1 = await insertCancelledOrder('recover', mo1, 'auto_cancelled_e04111_persistent')
    log('R1_BEFORE', o1)

    const r1 = await post('/api/webhooks/paycloud', {
      merchant_order_no: mo1,
      trans_status: 1, // untrusted payload claims NOT paid -- must be ignored
      sign: 'deadbeef-invalid-signature',
      __stagingFinaticStub: 'paid',
    })
    log('R1_HTTP', r1)
    const row1 = await readOrder(String(o1.id))
    log('R1_AFTER', row1)
    const audit1 = await readAudit(String(o1.id), 'payment.recovered_after_auto_cancel')
    log('R1_RECOVERY_AUDIT', audit1)

    assert(r1.status === 200, `R1: expected 200, got ${r1.status}`)
    assert(row1.payment_status === 'paid', `R1: expected paid, got ${row1.payment_status}`)
    assert(row1.status === 'completed', `R1: expected completed, got ${row1.status}`)
    assert(row1.cancelled_at === null, `R1: cancelled_at must clear, got ${row1.cancelled_at}`)
    assert(
      row1.cancellation_reason === null,
      `R1: cancellation_reason must clear, got ${row1.cancellation_reason}`,
    )
    assert(
      row1.paycloud_merchant_order_no === mo1,
      'R1: merchant order no must be preserved as evidence',
    )
    assert(audit1.length > 0, 'R1: expected payment.recovered_after_auto_cancel audit')
    assert(
      (audit1[0].metadata as any)?.severity === 'error',
      'R1: recovery audit must be error severity',
    )
    assert(
      (audit1[0].metadata as any)?.previousCancellationReason === 'auto_cancelled_e04111_persistent',
      'R1: recovery audit must record the previous cancellation reason',
    )
    console.log('R1_RECOVERED_AND_CLEARED_OK')

    // ---- R2: a verified payment we cannot apply must NOT be ACKed 200 ----
    // auto_timeout is deliberately outside the recovery scope, so the claim conflicts.
    const mo2 = `FTNOACK${Date.now()}`.slice(0, 32)
    const o2 = await insertCancelledOrder('no-ack', mo2, 'auto_timeout')
    log('R2_BEFORE', o2)

    const r2 = await post('/api/webhooks/paycloud', {
      merchant_order_no: mo2,
      trans_status: 2,
      sign: 'deadbeef-invalid-signature',
      __stagingFinaticStub: 'paid',
    })
    log('R2_HTTP', r2)
    const row2 = await readOrder(String(o2.id))
    log('R2_AFTER', row2)

    assert(r2.status === 503, `R2: expected 503 (no ACK), got ${r2.status}`)
    assert(
      JSON.stringify(r2.json).includes('claim_conflict'),
      `R2: expected claim_conflict in body, got ${r2.text}`,
    )
    assert(
      row2.payment_status === 'cancelled',
      `R2: staff/auto_timeout cancellation must not be revived, got ${row2.payment_status}`,
    )
    assert(
      (await readAudit(String(o2.id), 'payment.recovered_after_auto_cancel')).length === 0,
      'R2: must not emit a recovery audit for an out-of-scope cancellation',
    )
    console.log('R2_UNAPPLIED_CLAIM_NOT_ACKED_OK')

    // ---- R3: E04111 classified structurally end-to-end ----
    const mo3 = `FTE04111${Date.now()}`.slice(0, 32)
    const o3 = await insertCancelledOrder('e04111', mo3, 'auto_cancelled_e04111_persistent')

    const r3 = await post('/api/webhooks/paycloud', {
      merchant_order_no: mo3,
      trans_status: 2,
      sign: 'deadbeef-invalid-signature',
      __stagingFinaticStub: 'e04111',
    })
    log('R3_HTTP', r3)
    const row3 = await readOrder(String(o3.id))
    log('R3_AFTER', row3)

    assert(r3.status === 503, `R3: expected 503 so Finatic retries, got ${r3.status}`)
    assert(
      (r3.json as any)?.gatewayCode === 'E04111',
      `R3: expected structural gatewayCode E04111, got ${JSON.stringify((r3.json as any)?.gatewayCode)}`,
    )
    assert(
      row3.payment_status === 'cancelled',
      `R3: E04111 must change nothing, got ${row3.payment_status}`,
    )
    console.log('R3_E04111_CLASSIFIED_OK')

    console.log('PROBE_E04111_RECOVERY_OK')
  } finally {
    if (orderIds.length) {
      await admin.from('audit_logs').delete().in('entity_id', orderIds)
      await admin.from('orders').delete().in('id', orderIds)
      console.log('cleaned up probe orders:', orderIds.join(', '))
    }
  }
}

main().catch((err) => {
  console.error('PROBE_E04111_RECOVERY_FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
