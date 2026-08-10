/**
 * Staging probe for GitHub #82 — terminal callback cancel integrity.
 *
 * Triggers both broken paths against the staging Worker and prints the raw
 * orders row (status, payment_status, cancellation_reason, cancelled_at).
 *
 * Obtains a terminal JWT via /api/terminals/activate (no local TERMINAL_JWT_SECRET).
 *
 * Marker: PROBE_TERMINAL_CALLBACK_INTEGRITY_OK
 * Trigger: commit message contains [probe-terminal-callback-integrity]
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { generateTerminalActivationCode } from '../lib/terminals/activation-code'

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

  const tag = `cb-integrity-${Date.now()}`
  const activationCode = generateTerminalActivationCode()
  const deviceSerial = `probe-${tag}`

  // Pick any real restaurant on staging for the throwaway terminal.
  const { data: restaurant } = await admin
    .from('restaurants')
    .select('id')
    .limit(1)
    .maybeSingle()
  assert(restaurant?.id, 'need a restaurant on staging')
  const restaurantId = String(restaurant.id)

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

    // ---------- 1a: payment status=failed ----------
    const { data: orderA, error: orderAErr } = await admin
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        table_number: 0,
        channel: 'pos',
        status: 'pending',
        payment_status: 'pending',
        subtotal: 12.5,
        tax: 0,
        total: 12.5,
        items: [{ name: `${tag}-failed`, quantity: 1, price: 12.5 }],
        placed_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    assert(!orderAErr && orderA?.id, `orderA insert failed: ${orderAErr?.message}`)
    orderIds.push(String(orderA.id))

    const failRes = await httpJson(
      'POST',
      `/api/terminal/orders/${orderA.id}/payment`,
      {
        status: 'failed',
        reference: `${tag}-declined`,
        amount: 12.5,
        paymentMethod: 'card',
      },
      { Authorization: `Bearer ${accessToken}` },
    )
    log('payment_failed_response', failRes)
    assert(failRes.status === 200, `payment failed callback expected 200, got ${failRes.status}`)

    const { data: rowA, error: rowAErr } = await admin
      .from('orders')
      .select('id, status, payment_status, cancellation_reason, cancelled_at')
      .eq('id', orderA.id)
      .single()
    log('payment_failed_db_row', { rowAErr: rowAErr?.message || null, rowA })
    assert(rowA, 'orderA missing after callback')
    assert(rowA.status === 'cancelled', `status=${rowA.status}`)
    assert(rowA.payment_status === 'cancelled', `payment_status=${rowA.payment_status}`)
    assert(
      rowA.cancellation_reason === 'payment_declined',
      `cancellation_reason=${rowA.cancellation_reason}`,
    )
    assert(Boolean(rowA.cancelled_at), 'cancelled_at missing')
    console.log('PAYMENT_FAILED_FOUR_FIELDS_OK')

    // ---------- 1b: PATCH status=cancelled ----------
    const { data: orderB, error: orderBErr } = await admin
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        table_number: 0,
        channel: 'pos',
        status: 'pending',
        payment_status: 'pending',
        subtotal: 9,
        tax: 0,
        total: 9,
        items: [{ name: `${tag}-status`, quantity: 1, price: 9 }],
        placed_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    assert(!orderBErr && orderB?.id, `orderB insert failed: ${orderBErr?.message}`)
    orderIds.push(String(orderB.id))

    const statusRes = await httpJson(
      'PATCH',
      `/api/terminal/orders/${orderB.id}/status`,
      { status: 'cancelled' },
      { Authorization: `Bearer ${accessToken}` },
    )
    log('status_cancelled_response', statusRes)
    assert(statusRes.status === 200, `status cancel expected 200, got ${statusRes.status}`)

    const { data: rowB, error: rowBErr } = await admin
      .from('orders')
      .select('id, status, payment_status, cancellation_reason, cancelled_at')
      .eq('id', orderB.id)
      .single()
    log('status_cancelled_db_row', { rowBErr: rowBErr?.message || null, rowB })
    assert(rowB, 'orderB missing after PATCH')
    assert(rowB.status === 'cancelled', `status=${rowB.status}`)
    assert(rowB.payment_status === 'cancelled', `payment_status=${rowB.payment_status}`)
    assert(
      rowB.cancellation_reason === 'terminal_cancelled',
      `cancellation_reason=${rowB.cancellation_reason}`,
    )
    assert(Boolean(rowB.cancelled_at), 'cancelled_at missing')
    console.log('STATUS_CANCELLED_FOUR_FIELDS_OK')

    // ---------- 1b with caller-supplied reason ----------
    const { data: orderC, error: orderCErr } = await admin
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        table_number: 0,
        channel: 'pos',
        status: 'pending',
        payment_status: 'pending',
        subtotal: 3,
        tax: 0,
        total: 3,
        items: [{ name: `${tag}-reason`, quantity: 1, price: 3 }],
        placed_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    assert(!orderCErr && orderC?.id, `orderC insert failed: ${orderCErr?.message}`)
    orderIds.push(String(orderC.id))

    const statusReasonRes = await httpJson(
      'PATCH',
      `/api/terminal/orders/${orderC.id}/status`,
      { status: 'cancelled', cancellation_reason: 'customer_abandoned_at_terminal' },
      { Authorization: `Bearer ${accessToken}` },
    )
    log('status_cancelled_with_reason_response', statusReasonRes)
    assert(statusReasonRes.status === 200, `status+reason expected 200, got ${statusReasonRes.status}`)

    const { data: rowC } = await admin
      .from('orders')
      .select('id, status, payment_status, cancellation_reason, cancelled_at')
      .eq('id', orderC.id)
      .single()
    log('status_cancelled_with_reason_db_row', rowC)
    assert(rowC?.cancellation_reason === 'customer_abandoned_at_terminal', `got ${rowC?.cancellation_reason}`)
    assert(
      rowC?.payment_status === 'cancelled' && rowC?.status === 'cancelled',
      `orderC: caller-supplied reason must still cancel both fields, got status=${rowC?.status} payment_status=${rowC?.payment_status}`,
    )
    assert(
      Boolean(rowC?.cancelled_at),
      'orderC: cancelled_at missing after cancel with caller-supplied reason',
    )
    console.log('STATUS_CANCELLED_CALLER_REASON_OK')

    console.log('PROBE_TERMINAL_CALLBACK_INTEGRITY_OK')
  } finally {
    if (orderIds.length) {
      await admin.from('orders').delete().in('id', orderIds)
    }
    await admin.from('restaurant_terminals').delete().eq('id', terminalId)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
