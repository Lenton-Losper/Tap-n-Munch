/**
 * HTTP probe against the deployed staging Worker for Finatic-before-cancel guards
 * on payment status=failed and status PATCH cancelled (order #635 follow-up).
 *
 * Uses staging-only `__stagingFinaticStub` (ENVIRONMENT=staging on Worker) so
 * scenarios B/C/D exercise the real HTTP routes without live Finatic charges.
 *
 * Marker: PROBE_TERMINAL_FINATIC_GUARD_HTTP_OK
 * Trigger: commit message contains [probe-terminal-finatic-guard-http]
 *
 *   npx tsx scripts/probe-terminal-finatic-guard-http-staging.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { config } from 'dotenv'
import { resolve } from 'path'
import { generateTerminalActivationCode } from '../lib/terminals/activation-code'

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
  return { status: res.status, json, text }
}

async function main() {
  assert(url.includes(STAGING_REF) && serviceKey, 'Need staging URL + service role')
  log('worker', WORKER)
  log('supabase', url)

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const tag = `finatic-guard-http-${Date.now()}`
  const activationCode = generateTerminalActivationCode()
  const deviceSerial = `probe-${tag}`

  // Prefer a restaurant that already has Finatic creds so real-path credential
  // lookup also works; fall back to any restaurant (stub skips hard-fail).
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

  const { data: terminal, error: termErr } = await admin
    .from('restaurant_terminals')
    .insert({
      restaurant_id: restaurantId,
      terminal_name: tag,
      active: false,
      status: 'pending',
      activation_code: activationCode,
      activation_code_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      device_id: `pending-${randomUUID()}`,
    })
    .select('id')
    .single()
  assert(!termErr && terminal?.id, `terminal insert failed: ${termErr?.message}`)
  const terminalId = String(terminal.id)

  const orderIds: string[] = []

  const insertOrder = async (suffix: string, merchantOrderNo: string | null) => {
    const { data, error } = await admin
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        table_number: 0,
        channel: 'pos',
        status: 'pending',
        payment_status: 'pending',
        payment_method: 'card',
        subtotal: 8,
        tax: 0,
        total: 8,
        items: [{ name: `${tag}-${suffix}`, quantity: 1, price: 8 }],
        placed_at: new Date().toISOString(),
        paycloud_merchant_order_no: merchantOrderNo,
      })
      .select('id')
      .single()
    assert(!error && data?.id, `order insert ${suffix}: ${error?.message}`)
    orderIds.push(String(data.id))
    return String(data.id)
  }

  const readOrder = async (id: string) => {
    const { data, error } = await admin
      .from('orders')
      .select('id, status, payment_status, cancellation_reason, cancelled_at, payment_reference, paid_at')
      .eq('id', id)
      .single()
    assert(!error && data, `read order ${id}: ${error?.message}`)
    return data
  }

  try {
    const activate = await httpJson('POST', '/api/terminals/activate', {
      code: activationCode,
      deviceId: deviceSerial,
      terminalSn: deviceSerial,
    })
    log('activate', activate)
    assert(activate.status === 200, `activate failed: ${activate.status}`)
    const accessToken = String((activate.json as any)?.accessToken || '')
    assert(accessToken, 'activate did not return accessToken')
    const auth = { Authorization: `Bearer ${accessToken}` }

    // ========== PAYMENT status=failed ==========

    // A: no merchant_order_no → cancel
    const payA = await insertOrder('pay-a', null)
    const payARes = await httpJson(
      'POST',
      `/api/terminal/orders/${payA}/payment`,
      { status: 'failed', reference: `${tag}-fail-a`, amount: 8, paymentMethod: 'card' },
      auth,
    )
    log('PAYMENT_A_HTTP', payARes)
    const payARow = await readOrder(payA)
    log('PAYMENT_A_DB', payARow)
    assert(payARes.status === 200, `pay A status ${payARes.status}`)
    assert((payARes.json as any)?.outcome === 'cancelled' || (payARes.json as any)?.success === true)
    assert(payARow.status === 'cancelled' && payARow.payment_status === 'cancelled')
    assert(payARow.cancellation_reason === 'payment_declined')
    console.log('PAYMENT_A_NO_MERCHANT_CANCELLED_OK')

    // B: Finatic paid stub → corrected
    const payB = await insertOrder('pay-b', `FTPAYB${Date.now()}`.slice(0, 32))
    const payBRes = await httpJson(
      'POST',
      `/api/terminal/orders/${payB}/payment`,
      {
        status: 'failed',
        reference: `${tag}-fail-b`,
        amount: 8,
        paymentMethod: 'card',
        __stagingFinaticStub: 'paid',
      },
      auth,
    )
    log('PAYMENT_B_HTTP', payBRes)
    const payBRow = await readOrder(payB)
    log('PAYMENT_B_DB', payBRow)
    assert(payBRes.status === 200, `pay B status ${payBRes.status}`)
    assert((payBRes.json as any)?.outcome === 'corrected_to_paid', `pay B outcome=${JSON.stringify(payBRes.json)}`)
    assert(payBRow.status === 'completed' && payBRow.payment_status === 'paid')
    assert(!payBRow.cancellation_reason && !payBRow.cancelled_at)
    console.log('PAYMENT_B_FALSE_FAILURE_CORRECTED_OK')

    // C: Finatic not paid → cancel
    const payC = await insertOrder('pay-c', `FTPAYC${Date.now()}`.slice(0, 32))
    const payCRes = await httpJson(
      'POST',
      `/api/terminal/orders/${payC}/payment`,
      {
        status: 'failed',
        reference: `${tag}-fail-c`,
        amount: 8,
        paymentMethod: 'card',
        __stagingFinaticStub: 'not_paid',
      },
      auth,
    )
    log('PAYMENT_C_HTTP', payCRes)
    const payCRow = await readOrder(payC)
    log('PAYMENT_C_DB', payCRow)
    assert(payCRes.status === 200, `pay C status ${payCRes.status}`)
    assert((payCRes.json as any)?.outcome === 'cancelled')
    assert(payCRow.status === 'cancelled' && payCRow.cancellation_reason === 'payment_declined')
    console.log('PAYMENT_C_NOT_PAID_CANCELLED_OK')

    // D: Finatic unreachable → leave pending
    const payD = await insertOrder('pay-d', `FTPAYD${Date.now()}`.slice(0, 32))
    const payDRes = await httpJson(
      'POST',
      `/api/terminal/orders/${payD}/payment`,
      {
        status: 'failed',
        reference: `${tag}-fail-d`,
        amount: 8,
        paymentMethod: 'card',
        __stagingFinaticStub: 'unreachable',
      },
      auth,
    )
    log('PAYMENT_D_HTTP', payDRes)
    const payDRow = await readOrder(payD)
    log('PAYMENT_D_DB', payDRow)
    assert(payDRes.status === 200, `pay D status ${payDRes.status}`)
    assert((payDRes.json as any)?.outcome === 'left_pending_finatic_uncertain', `pay D=${JSON.stringify(payDRes.json)}`)
    assert(payDRow.status === 'pending' && payDRow.payment_status === 'pending')
    assert(!payDRow.cancelled_at)
    const { data: payDAudit } = await admin
      .from('audit_logs')
      .select('*')
      .eq('entity_id', payD)
      .eq('action', 'payment.verification_uncertain')
    log('PAYMENT_D_UNCERTAIN_AUDIT', payDAudit)
    assert((payDAudit?.length ?? 0) === 1, 'pay D: expected payment.verification_uncertain audit')
    assert((payDAudit?.[0]?.metadata as any)?.outcome === 'left_pending_finatic_uncertain')
    console.log('PAYMENT_D_UNREACHABLE_LEFT_PENDING_OK')
    console.log('PAYMENT_D_VERIFICATION_UNCERTAIN_AUDIT_OK')

    // ========== STATUS PATCH cancelled ==========

    // A: no merchant_order_no → cancel immediately
    const stA = await insertOrder('st-a', null)
    const stARes = await httpJson(
      'PATCH',
      `/api/terminal/orders/${stA}/status`,
      { status: 'cancelled' },
      auth,
    )
    log('STATUS_A_HTTP', stARes)
    const stARow = await readOrder(stA)
    log('STATUS_A_DB', stARow)
    assert(stARes.status === 200, `status A ${stARes.status}`)
    assert(stARow.status === 'cancelled' && stARow.payment_status === 'cancelled')
    assert(stARow.cancellation_reason === 'terminal_cancelled')
    console.log('STATUS_A_NO_MERCHANT_CANCELLED_OK')

    // B: Finatic paid stub → corrected
    const stB = await insertOrder('st-b', `FTSTB${Date.now()}`.slice(0, 32))
    const stBRes = await httpJson(
      'PATCH',
      `/api/terminal/orders/${stB}/status`,
      { status: 'cancelled', __stagingFinaticStub: 'paid' },
      auth,
    )
    log('STATUS_B_HTTP', stBRes)
    const stBRow = await readOrder(stB)
    log('STATUS_B_DB', stBRow)
    assert(stBRes.status === 200, `status B ${stBRes.status}`)
    assert((stBRes.json as any)?.outcome === 'corrected_to_paid', `status B=${JSON.stringify(stBRes.json)}`)
    assert(stBRow.status === 'completed' && stBRow.payment_status === 'paid')
    console.log('STATUS_B_FALSE_CANCEL_CORRECTED_OK')

    // C: Finatic not paid → cancel with terminal_cancelled
    const stC = await insertOrder('st-c', `FTSTC${Date.now()}`.slice(0, 32))
    const stCRes = await httpJson(
      'PATCH',
      `/api/terminal/orders/${stC}/status`,
      { status: 'cancelled', __stagingFinaticStub: 'not_paid' },
      auth,
    )
    log('STATUS_C_HTTP', stCRes)
    const stCRow = await readOrder(stC)
    log('STATUS_C_DB', stCRow)
    assert(stCRes.status === 200, `status C ${stCRes.status}`)
    assert((stCRes.json as any)?.outcome === 'cancelled')
    assert(stCRow.status === 'cancelled' && stCRow.cancellation_reason === 'terminal_cancelled')
    console.log('STATUS_C_NOT_PAID_CANCELLED_OK')

    // D: Finatic unreachable → leave pending
    const stD = await insertOrder('st-d', `FTSTD${Date.now()}`.slice(0, 32))
    const stDRes = await httpJson(
      'PATCH',
      `/api/terminal/orders/${stD}/status`,
      { status: 'cancelled', __stagingFinaticStub: 'unreachable' },
      auth,
    )
    log('STATUS_D_HTTP', stDRes)
    const stDRow = await readOrder(stD)
    log('STATUS_D_DB', stDRow)
    assert(stDRes.status === 200, `status D ${stDRes.status}`)
    assert((stDRes.json as any)?.outcome === 'left_pending_finatic_uncertain', `status D=${JSON.stringify(stDRes.json)}`)
    assert(stDRow.status === 'pending' && stDRow.payment_status === 'pending')
    const { data: stDAudit } = await admin
      .from('audit_logs')
      .select('*')
      .eq('entity_id', stD)
      .eq('action', 'payment.verification_uncertain')
    log('STATUS_D_UNCERTAIN_AUDIT', stDAudit)
    assert((stDAudit?.length ?? 0) === 1, 'status D: expected payment.verification_uncertain audit')
    console.log('STATUS_D_UNREACHABLE_LEFT_PENDING_OK')
    console.log('STATUS_D_VERIFICATION_UNCERTAIN_AUDIT_OK')

    console.log('PROBE_TERMINAL_FINATIC_GUARD_HTTP_OK')
  } finally {
    if (orderIds.length) {
      await admin.from('audit_logs').delete().in('entity_id', orderIds)
      await admin.from('receipt_documents').delete().in('order_id', orderIds)
      await admin.from('orders').delete().in('id', orderIds)
    }
    await admin.from('restaurant_terminals').delete().eq('id', terminalId)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
